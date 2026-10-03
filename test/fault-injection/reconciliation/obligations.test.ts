/**
 * WP-290 acceptance 4: THE OBLIGATIONS OTHER PACKAGES PUT ON THE RECONCILER.
 *
 * - WP-270 (decisions; follow_up 3): every ABSENT attests
 *   `transmissionQuiescent`, from the coordinator's own clock; `requestId` is
 *   echoed; attempts are reconciled by signed identity (the ambiguity refusal
 *   is acceptance 1's).
 * - WP-280 (follow_up 1): its reconciliation requests are consumed (they
 *   pause, trigger a run, and are acknowledged by id only after a complete
 *   run whose reads began after their receipt) and its normalized events are
 *   routed to the OMS.
 * - WP-300 / WP-300c (ADR-032 D4, D5; WP300C-OBLIGATIONS): `requestId` is
 *   echoed; no request is ever answered with a read made before it was
 *   received; after a DROPPED, UNKNOWN or malformed report each identity
 *   member is answered BY NAME once terminal; `retryReconciliationRequests`
 *   is called every run (the OMS's and the inventory's).
 * - V3-E15: Data API v1 routes are refused; only `/v2` is read.
 */

import { describe, expect, it } from "vitest";

import { ApprovalTracker, WalletOperationManager, type ReconciliationRequest as InventoryRequest } from "../../../packages/inventory/src/index.js";
import type { ReconciledWalletOperations } from "../../../packages/oms/src/index.js";
import { group, ticket } from "../../unit/oms/support/harness.js";
import { ACCOUNT as INVENTORY_ACCOUNT, CONDITION, NO as INV_NO, PUSD as INV_PUSD, YES as INV_YES, requestTokens, seededBook } from "../../unit/inventory/helpers.js";

import { YES, streamTrade } from "./support/harness.js";
import { expectPaused, ready, reconcileRounds, sequence, submitOne, type Ready } from "./support/scenario.js";

/** Every answer was given to a request received BEFORE the first read of the run that answered it (ADR-032 D4). */
function answersFollowReceipts(log: readonly string[], prefix: "oms" | "wallet"): string[] {
  const problems: string[] = [];
  log.forEach((entry, index) => {
    if (!entry.startsWith(`answer:${prefix}:`)) return;
    const id = entry.slice(`answer:${prefix}:`.length);
    let runReads = -1;
    for (let back = index; back >= 0; back -= 1) {
      if (log[back] === "read:listOpenOrders") {
        runReads = back;
        break;
      }
    }
    const received = log.indexOf(`recv:${prefix}:${id}`);
    if (received < 0 || runReads < 0 || received > runReads) problems.push(`answer to ${id} (received at ${String(received)}) used reads that began at ${String(runReads)}`);
  });
  return problems;
}

describe("WP-270: quiescence, requestId, signed identity", () => {
  it("ABSENT only once the reads begin a full horizon after RECEIPT, by the coordinator's clock, and always attests transmissionQuiescent", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    const received = r.u.clock.t;
    const attempt = await submitOne(r.oms);
    for (const at of [received, received + 1, received + r.u.policy.quiescenceHorizonMs - 1]) {
      r.u.clock.t = at;
      const report = await r.p.coordinator.reconcile();
      expect(report.resumed, `no ABSENT at +${String(at - received)} ms`).toBe(false);
      expect(r.u.accepted).toEqual([]);
    }
    r.u.clock.t = received + r.u.policy.quiescenceHorizonMs;
    const report = await r.p.coordinator.reconcile();
    expect(report.resumed).toBe(true);
    expect(r.u.accepted).toEqual([{ verdict: "ABSENT", attemptId: attempt, venueOrderId: null, quiescent: true }]);
    expect(r.u.violations).toEqual([]);
  });

  it("a marketable order matched at once, whose trade the read lags: never ABSENT while the holdings show the fill", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    const attempt = await submitOne(r.oms);
    r.u.world.match(r.u.world.receipts.at(-1) as string, "1"); // fully matched: gone from the open-orders list
    r.u.world.faults.listTrades = (answer) => ({ ...(answer() as object), trades: [] }); // the trade is not visible yet
    expect(await reconcileRounds(r, 4)).toBe(false);
    expect(r.u.accepted).toEqual([]);
    expect(r.p.journal.unresolvedBreaks().map((view) => view.breakClass)).toContain("HOLDING_DELTA_UNCONFIRMED");
    r.u.world.faults = {};
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    expect(r.oms.attempt(attempt as string)?.venueOrderId).not.toBeNull();
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("a venue order id the stream named and the OMS retains is a candidate: found PRESENT, not ABSENT", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const trade = r.u.world.match(salt, "1", { status: "TRADE_STATUS_MATCHED" });
    // Matched, not on chain yet (the holdings do not show it), and the trades read lags; only the stream saw it.
    r.u.world.adjustPosition(YES, "-1");
    r.u.world.adjustCollateral("0.5");
    r.u.world.faults.listTrades = (answer) => ({ ...(answer() as object), trades: [] });
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? ""));
    await r.p.coordinator.settled();
    expect(r.oms.retainedEvidence().map((item) => item.kind)).toEqual(["FILL"]);
    await reconcileRounds(r, 3);
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    expect(r.oms.alerts().filter((alert) => alert.haltMarket)).toEqual([]);
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("a transmission still travelling inside the horizon is found PRESENT once it arrives, never answered ABSENT", async () => {
    const r = await ready();
    r.u.world.lateMs = r.u.policy.quiescenceHorizonMs - 1;
    r.u.world.nextTransmission = sequence(["LATE_ARRIVAL"]);
    const attempt = await submitOne(r.oms);
    expect(await reconcileRounds(r, 4)).toBe(true);
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    expect(r.oms.attempt(attempt as string)?.venueOrderId).not.toBeNull();
    expect([...r.u.violations, ...r.u.world.violations]).toEqual([]);
  });

  it("a clock that went backwards since receipt restarts the quiescence window: no early ABSENT, ABSENT later", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    const received = r.u.clock.t;
    await submitOne(r.oms);
    r.u.clock.t = received - 10_000; // a backwards step after the receipt
    await r.p.coordinator.reconcile();
    r.u.clock.t = received + r.u.policy.quiescenceHorizonMs; // past the horizon by the old reading, not the new one
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    expect(r.u.accepted).toEqual([]);
    r.u.clock.t += r.u.policy.quiescenceHorizonMs + 20_000;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(true);
    expect(r.u.accepted.map((answer) => [answer.verdict, answer.quiescent])).toEqual([["ABSENT", true]]);
  });

  it("a backwards reading at the very moment of receipt is never used, and does not withhold ABSENT for good", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_ABSENT"]);
    r.u.clock.t -= 60_000; // the step happens before the request arrives: its receipt reading is the faulty one
    await submitOne(r.oms);
    const stamped = r.u.clock.t;
    await r.p.coordinator.reconcile(); // the first sound reading after the fault starts the window
    r.u.clock.t = stamped + r.u.policy.quiescenceHorizonMs - 1;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(false);
    r.u.clock.t = stamped + r.u.policy.quiescenceHorizonMs;
    expect((await r.p.coordinator.reconcile()).resumed).toBe(true);
    expect(r.u.accepted.map((answer) => [answer.verdict, answer.quiescent])).toEqual([["ABSENT", true]]);
  });

  it("every answer echoes its request's id verbatim, however opaque (a 64-character token with separators)", async () => {
    // 64, not 128: the OMS refuses an answer whose id exceeds 200 characters, which its own ids do once the token
    // exceeds 118 (WP290-F1, a WP-270 finding reported in the handoff).
    let n = 0;
    const r = await ready({ requestToken: () => `${String((n += 1))}:;${"x".repeat(58)};:` });
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS", "UNKNOWN_ABSENT"]);
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    // The first order is live, so its group's salt gate is closed: the second attempt is in another group.
    const second = group(9004, { tokenId: YES, plannedShares: "5" });
    expect((await r.oms.registerGroup(second)).ok).toBe(true);
    expect((await r.oms.submit(ticket(second, { n: 901, shares: "1", limitPrice: "0.4" }))).ok).toBe(true);
    expect(await reconcileRounds(r, 3)).toBe(true);
    const issued = new Map(r.u.omsRequests.map((request) => [request.requestId, request.submissionAttemptId]));
    const answers = r.p.journal.events().filter((event) => event.kind === "ANSWER_RECORDED" && event.channel === "ORDER");
    expect(answers.length).toBe(2);
    for (const event of answers) {
      if (event.kind !== "ANSWER_RECORDED") continue;
      expect(issued.get(event.requestId), event.requestId).toBe(event.subjectId);
    }
    expect(answersFollowReceipts(r.u.log, "oms")).toEqual([]);
  });

  it("an OMS request raised DURING the reads is never answered with them; the next run answers it (ADR-032 D4)", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const orderId = r.oms.orders()[0]?.orderId as string;
    let raised = false;
    r.u.world.faults.onRead = (name) => {
      if (name === "listTrades" && !raised) {
        raised = true;
        void r.oms.requestOrderReconciliation(orderId);
      }
    };
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    expect(raised).toBe(true);
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    expect(answersFollowReceipts(r.u.log, "oms")).toEqual([]);
    expect(report.resumed).toBe(true);
    expect(report.runs.length).toBeGreaterThan(1);
  });

  it("by signed identity: an unknown attempt is matched only among UNCLAIMED orders (a tracked twin is not a candidate)", async () => {
    const r = await ready();
    const twin = group(9003, { tokenId: YES, plannedShares: "5" });
    expect((await r.oms.registerGroup(twin)).ok).toBe(true);
    r.u.world.nextTransmission = sequence(["ACCEPT_LIVE", "UNKNOWN_EXISTS"]);
    const batch = await r.oms.submitBatch([ticket(twin, { n: 801, shares: "1" }), ticket(group(9001, { tokenId: YES, plannedShares: "5" }), { n: 802, shares: "1" })]);
    expect(batch.ok).toBe(true);
    expect(await reconcileRounds(r, 3)).toBe(true);
    // R3 (the oracle) checked that the PRESENT named the attempt's own order, not its tracked twin.
    expect(r.u.accepted.map((answer) => answer.verdict)).toEqual(["PRESENT"]);
    expect(new Set(r.oms.attempts().map((attempt) => attempt.venueOrderId)).size).toBe(2);
    expect(r.u.violations).toEqual([]);
  });

  it("the expected order hash is null (STOPPED) in every request, and the match never needs it", async () => {
    const r = await ready();
    r.u.world.nextTransmission = sequence(["UNKNOWN_EXISTS"]);
    await submitOne(r.oms);
    expect(await reconcileRounds(r, 3)).toBe(true);
    expect(r.u.omsRequests.length).toBeGreaterThan(0);
    expect(r.u.omsRequests.every((request) => request.expectedOrderHash === null)).toBe(true);
  });
});

/** A WP-280 stand-in: the real manager refuses to construct in PAPER (its signer gate). */
class FakeStream {
  readonly pending: { readonly requestId: string; readonly cause: string; readonly markets: readonly string[] }[] = [];
  readonly acknowledged: string[] = [];
  pendingReconciliationRequests(): readonly { readonly requestId: string; readonly cause: string; readonly markets: readonly string[] }[] {
    return [...this.pending];
  }
  acknowledgeReconciliationRequest(requestId: string): boolean {
    const index = this.pending.findIndex((request) => request.requestId === requestId);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.acknowledged.push(requestId);
    return true;
  }
  raise(r: Ready, requestId: string, cause: string): void {
    const request = { requestId, cause, markets: [], afterLoss: null, subscriptionGeneration: 1, shortfalls: [], unrecognized: null, venueOrderIds: [], venueTradeId: null, requestedAt: null };
    this.pending.push(request);
    r.p.coordinator.onUserStreamOutput({ kind: "RECONCILIATION_REQUESTED", request });
  }
}

describe("WP-280: its reconciliation requests and normalized events", () => {
  it("a reconnect request pauses at once, triggers USER_STREAM_RECONNECT, and is acknowledged by id after a complete run", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    stream.raise(r, "stream-req-1", "SOCKET_CLOSED");
    expect(r.oms.paused).toBe(true);
    // A failed read: the request is not acknowledged.
    r.u.world.faults.listTrades = () => {
      throw new Error("down");
    };
    const failed = await r.p.coordinator.reconcile();
    expect(failed.runs[0]?.triggers).toEqual(["USER_STREAM_RECONNECT"]);
    expect(stream.acknowledged).toEqual([]);
    expect(r.oms.paused).toBe(true);
    r.u.world.faults = {};
    expect((await r.p.coordinator.reconcile()).resumed).toBe(true);
    expect(stream.acknowledged).toEqual(["stream-req-1"]);
    const recorded = r.p.journal.events().filter((event) => event.kind === "ANSWER_RECORDED" && event.channel === "USER_STREAM");
    expect(recorded).toEqual([]); // acknowledgements are reported per run, and the stream holds the durable backlog
  });

  it("a request raised DURING the reads is not acknowledged by that run; the next run, at once, acknowledges it", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    stream.raise(r, "stream-req-1", "SOCKET_CLOSED");
    let raised = false;
    r.u.world.faults.onRead = (name) => {
      if (name === "listTrades" && !raised) {
        raised = true;
        stream.raise(r, "stream-req-2", "RESUBSCRIBED");
      }
    };
    const report = await r.p.coordinator.reconcile();
    expect(report.runs.length).toBe(2);
    expect(report.runs[0]?.answers.map((answer) => answer.requestId)).toEqual(["stream-req-1"]);
    expect(report.runs[1]?.answers.map((answer) => answer.requestId)).toEqual(["stream-req-2"]);
    expect(report.resumed).toBe(true);
  });

  it("a request caused by an event the OMS could not apply triggers POSITION_BALANCE_DISCREPANCY", async () => {
    const r = await ready();
    const stream = new FakeStream();
    r.p.coordinator.bindUserStream(stream);
    stream.raise(r, "stream-req-1", "EVENT_NOT_FULLY_APPLICABLE");
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.triggers).toEqual(["POSITION_BALANCE_DISCREPANCY"]);
  });

  it("normalized events are routed to the OMS: an observation and a fill of a tracked order are applied", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const trade = r.u.world.match(salt, "0.4");
    r.p.coordinator.onUserStreamOutput(streamTrade(r.u, trade?.venueTradeId ?? ""));
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: `venue-${salt}`, status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    expect(r.oms.orders()[0]?.filledShares).toBe("0.4");
    expect(r.oms.paused).toBe(false);
  });

  it("an event naming a venue order no attempt can own pauses and triggers a run (the OMS's halting alert is quarantined)", async () => {
    const r = await ready();
    r.p.coordinator.onUserStreamOutput({ kind: "ORDER", oms: { observation: { venueOrderId: "venue-unknown-1", status: "LIVE" }, shortfalls: [] } });
    await r.p.coordinator.settled();
    expect(r.oms.paused).toBe(true);
    const report = await r.p.coordinator.reconcile();
    expect(report.runs[0]?.triggers).toContain("POSITION_BALANCE_DISCREPANCY");
    await expectPaused(r, report.resumed, "OMS_HALTING_ALERT");
  });

  it("events that arrive during a run are applied after it, in order", async () => {
    const r = await ready();
    await submitOne(r.oms);
    const salt = r.u.world.receipts.at(-1) as string;
    const first = r.u.world.match(salt, "0.25");
    const second = r.u.world.match(salt, "0.25");
    let sent = false;
    r.u.world.faults.onRead = (name) => {
      if (name === "listOpenOrders" && !sent) {
        sent = true;
        r.p.coordinator.onUserStreamOutput(streamTrade(r.u, first?.venueTradeId ?? ""));
        r.p.coordinator.onUserStreamOutput(streamTrade(r.u, second?.venueTradeId ?? ""));
      }
    };
    await r.p.coordinator.reconcile();
    await r.p.coordinator.settled();
    expect(r.oms.orders()[0]?.filledShares).toBe("0.5");
  });
});

interface WalletRig {
  readonly wallet: WalletOperationManager;
  readonly answers: Record<string, unknown>[];
  readonly requests: InventoryRequest[];
  retries: number;
  respond: () => unknown;
}

/** A real WP-300 manager bound to the coordinator, its executor a mock (nothing is signed or sent). */
function walletRig(r: Ready): WalletRig {
  const rig: { wallet: WalletOperationManager | null; answers: Record<string, unknown>[]; requests: InventoryRequest[]; retries: number; respond: () => unknown } = {
    wallet: null,
    answers: [],
    requests: [],
    retries: 0,
    respond: () => ({ status: "SUBMITTED", transactionHash: HASH_A, transactionId: null }),
  };
  const wallet = new WalletOperationManager({
    requestToken: requestTokens("w"),
    book: seededBook({ [INV_PUSD]: "100", [INV_YES]: "20", [INV_NO]: "20" }),
    approvals: new ApprovalTracker(),
    executor: { submit: async () => rig.respond() },
    reconciler: {
      request: (request) => {
        rig.requests.push(request);
        r.u.log.push(`recv:wallet:${request.requestId}`);
        r.p.coordinator.walletRequester.request(request);
      },
    },
  });
  rig.wallet = wallet;
  const port: ReconciledWalletOperations = {
    resolveByReconciliation: (operationId, evidence) => {
      const answer = evidence as Record<string, unknown>;
      rig.answers.push(answer);
      r.u.log.push(`answer:wallet:${String(answer["requestId"])}`);
      return wallet.resolveByReconciliation(operationId, evidence);
    },
    retryReconciliationRequests: () => {
      rig.retries += 1;
      return wallet.retryReconciliationRequests();
    },
    outstandingReconciliationRequests: () => wallet.outstandingReconciliationRequests(),
    events: () => wallet.events(),
    operation: (operationId) => wallet.operation(operationId),
  };
  r.p.coordinator.bindWalletOperations(port);
  return rig as WalletRig;
}

const HASH_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const HASH_B = "0x00000000000000000000000000000000000000000000000000000000000000b2";
const split = { type: "SPLIT", operationId: "op-split-290", accountRef: INVENTORY_ACCOUNT, conditionId: CONDITION, amount: "10" };

describe("WP-300 / WP-300c: wallet operations answered by name, after receipt, with the request's id", () => {
  it("after an UNKNOWN report the member is waited out while PENDING, then answered by name once terminal, echoing requestId", async () => {
    const r = await ready();
    const rig = walletRig(r);
    expect(rig.wallet.plan(split).ok).toBe(true);
    expect((await rig.wallet.submit(split.operationId)).ok).toBe(true);
    rig.wallet.observe(split.operationId, { status: "DROPPED", transactionHash: HASH_A });
    expect(rig.wallet.operation(split.operationId)?.state).toBe("RECONCILING");
    expect(r.oms.paused).toBe(true);
    r.u.world.walletMembers.set(`hash:${HASH_A}`, { state: "PENDING", transactionHash: HASH_A, credited: null });
    const pending = await r.p.coordinator.reconcile();
    await expectPaused(r, pending.resumed, "WALLET_MEMBER_PENDING");
    expect(rig.answers).toEqual([]);
    r.u.world.walletMembers.set(`hash:${HASH_A}`, { state: "CONFIRMED", transactionHash: HASH_A, credited: null });
    expect(await reconcileRounds(r, 3)).toBe(true);
    const latest = rig.requests.at(-1);
    expect(rig.answers).toEqual([{ source: "AUTHORITATIVE_READ", requestId: latest?.requestId, state: "CONFIRMED", transactionHash: HASH_A, transactionId: null }]);
    expect(rig.wallet.operation(split.operationId)?.state).toBe("CONFIRMED");
    expect(answersFollowReceipts(r.u.log, "wallet")).toEqual([]);
  });

  it("two members (a contradiction in flight): each is answered BY NAME, with its own terminal state", async () => {
    const r = await ready();
    const rig = walletRig(r);
    rig.wallet.plan(split);
    await rig.wallet.submit(split.operationId);
    rig.wallet.observe(split.operationId, { status: "CONFIRMED", transactionHash: HASH_B, transactionId: null });
    const unresolved = rig.wallet.operation(split.operationId)?.unresolvedTransactions ?? [];
    expect([...unresolved].sort()).toEqual([`hash:${HASH_A}`, `hash:${HASH_B}`].sort());
    r.u.world.walletMembers.set(`hash:${HASH_A}`, { state: "FAILED", transactionHash: HASH_A, credited: null });
    r.u.world.walletMembers.set(`hash:${HASH_B}`, { state: "CONFIRMED", transactionHash: HASH_B, credited: null });
    await reconcileRounds(r, 3);
    const named = rig.answers.map((answer) => [answer["transactionHash"], answer["state"]]);
    expect(named).toContainEqual([HASH_A, "FAILED"]);
    expect(named).toContainEqual([HASH_B, "CONFIRMED"]);
    expect(rig.answers.every((answer) => answer["source"] === "AUTHORITATIVE_READ" && typeof answer["requestId"] === "string")).toBe(true);
    expect(answersFollowReceipts(r.u.log, "wallet")).toEqual([]);
  });

  it("a request raised DURING the reads is never answered with them; the next run answers it", async () => {
    const r = await ready();
    const rig = walletRig(r);
    rig.wallet.plan(split);
    await rig.wallet.submit(split.operationId);
    rig.wallet.observe(split.operationId, { status: "DROPPED", transactionHash: HASH_A });
    r.u.world.walletMembers.set(`hash:${HASH_A}`, { state: "CONFIRMED", transactionHash: HASH_A, credited: null });
    let raised = false;
    r.u.world.faults.onRead = (name) => {
      if (name === "listTrades" && !raised) {
        raised = true;
        // New evidence mid-read: the inventory issues a fresh request, which supersedes the one the run will answer.
        rig.wallet.observe(split.operationId, { status: "DROPPED", transactionHash: HASH_B });
      }
    };
    await reconcileRounds(r, 3);
    expect(raised).toBe(true);
    expect(answersFollowReceipts(r.u.log, "wallet")).toEqual([]);
    expect(rig.requests.length).toBeGreaterThan(1);
  });

  it("an operation that never named a transaction is quarantined, never answered", async () => {
    const r = await ready();
    const rig = walletRig(r);
    rig.respond = () => {
      throw new Error("executor unreachable");
    };
    rig.wallet.plan(split);
    await rig.wallet.submit(split.operationId);
    const view = rig.wallet.operation(split.operationId);
    expect(view?.state).toBe("RECONCILING");
    expect([view?.transactionHashes, view?.transactionIds]).toEqual([[], []]);
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "WALLET_OPERATION_UNIDENTIFIABLE");
    expect(r.p.journal.unresolvedBreaks().find((view) => view.breakClass === "WALLET_OPERATION_UNIDENTIFIABLE")?.status).toBe("QUARANTINED");
    expect(rig.answers).toEqual([]);
  });

  it("retryReconciliationRequests is called on the OMS and the inventory in every run (ADR-032 D5)", async () => {
    const r = await ready();
    const rig = walletRig(r);
    const before = r.u.omsRetries;
    for (let index = 0; index < 3; index += 1) {
      r.p.coordinator.trigger("PERIODIC_TIMER");
      await r.p.coordinator.reconcile();
    }
    expect(r.u.omsRetries - before).toBe(3);
    expect(rig.retries).toBe(3);
  });
});

describe("V3-E15: Data API v2 only", () => {
  for (const [read, route] of [
    ["readPositions", "/positions"],
    ["readPositions", "/v1/market-positions"],
    ["readApprovals", "/v1/approvals"],
  ] as const) {
    it(`a ${read} answer from ${route} is refused (READ_WRONG_ROUTE): paused`, async () => {
      const r = await ready();
      r.u.world.faults[read] = (answer) => ({ ...(answer() as object), route });
      r.p.coordinator.trigger("PERIODIC_TIMER");
      const report = await r.p.coordinator.reconcile();
      await expectPaused(r, report.resumed, "READ_WRONG_ROUTE");
    });
  }

  it("a collateral balance from the CLOB's balance-allowance cache is refused (U-22): paused", async () => {
    const r = await ready();
    r.u.world.faults.readCollateral = (answer) => ({ ...(answer() as object), source: "CLOB_BALANCE_ALLOWANCE" });
    r.p.coordinator.trigger("PERIODIC_TIMER");
    const report = await r.p.coordinator.reconcile();
    await expectPaused(r, report.resumed, "READ_WRONG_ROUTE");
  });
});
