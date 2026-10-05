/**
 * cancel-all (handoff §14.2; ADR-008 §6; work-plan WP-330 acceptance 1:
 * "cancel-all does not require trader state"), and WP-310's obligations on
 * WP-330 (follow_up 4, OP-R1-09): the emergency class, the canceled count,
 * D-21 debt, and batch cancels split to at most the burst minus headroom.
 */

import { RateLimitBudget, type Grant, type GrantCompletion, type SecureVenueClient, type SignerGateContext } from "@polymarket-bot/polymarket-secure";
import {
  createFakeSdkFactory,
  createMockSignerHandle,
  createSecureVenueClientForTesting,
  installNetworkTripwire,
  MOCK_SIGNER_ADDRESS,
  type FakeSdkScript,
  type NetworkTripwire,
} from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import type { AuditMirror, AuditRecord } from "./audit-log.js";
import { EmergencyBudget, type AcquireResult } from "./budget.js";
import { MAX_SWEEP_RESPLITS } from "./commands/cancel.js";
import { EXIT_CODES } from "./exit-codes.js";
import {
  ACCOUNT,
  args,
  contractSnapshot,
  DESTRUCTIVE_REASON,
  harness,
  order,
  phases,
  rateLimited,
  refusedUnapplied,
  SIGNER,
  T0,
  testConfiguration,
  transportFailure,
  type Harness,
} from "./harness.test-support.js";
import type { EmergencyVenueFactory } from "./ports.js";
import { runOpsCli } from "./run.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  vi.restoreAllMocks();
  tripwire.uninstall();
  expect(tripwire.refused()).toEqual([]);
});

const CONFIRM = ["--confirm", `cancel-all:${ACCOUNT}`];
const cancelAll = (...extra: string[]): string[] => args("cancel-all", ...DESTRUCTIVE_REASON, ...extra);

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(4, "0")}`);
}

describe("acceptance 1: cancel-all does not require trader state", () => {
  it("with the database UNREACHABLE (its mirror never answers) and NO trader, cancel-all completes from venue truth and the emergency credential alone", async () => {
    let mirrorCalls = 0;
    const hangingDatabase: AuditMirror = {
      append: () => {
        mirrorCalls += 1;
        return new Promise<void>(() => undefined); // a database that never answers
      },
    };
    const h = harness({ mirror: hangingDatabase });
    h.venue.add(order("o-1"), order("o-2"), order("o-3", { tokenId: "2222" }));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.venue.open()).toEqual([]);
    expect(h.venue.callsOf("cancelAll")).toHaveLength(1);
    // Only the operator's configuration, the EMERGENCY credential and the venue were touched: no lease store
    // (LEASES_FORBIDDEN throws if opened), no ledger projection, no trader port (none exists in the dependencies).
    expect(h.touched).toEqual(["configuration", "credentials", "venues"]);
    // The database was asked (best effort) and never answered; nothing waited on it before acting.
    expect(mirrorCalls).toBeGreaterThan(0);
    expect(h.text()).toMatch(/database copy \(ops\.config_change_audit\): 0 landed, 0 failed, \d+ still pending/u);
    expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
  });

  it("with the database REFUSING every write, cancel-all still completes; the failure is reported, not fatal", async () => {
    const refusingDatabase: AuditMirror = { append: () => Promise.reject(new Error("connect ECONNREFUSED")) };
    const h = harness({ mirror: refusingDatabase });
    h.venue.add(order("o-1"));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.text()).toContain("database copy (ops.config_change_audit): 0 landed, 3 failed, 0 still pending");
  });

  it("cancel-all acts even when the open-orders read fails: venue truth is reported unknown, the cancel is still sent", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    let reads = 0;
    h.venue.scripted.set("listOpenOrders", () => {
      reads += 1;
      return Promise.reject(transportFailure("FETCH_ORDER"));
    });
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(h.venue.callsOf("cancelAll")).toHaveLength(1);
    expect(reads).toBe(2);
    expect(outcome.exitName).toBe("COMPLETED"); // the answer canceled o-1 and named nothing not canceled; unverified
    expect(h.text()).toContain("venue truth now: NOT READ");
    expect(h.text()).toContain("the account's open orders after the cancels: the read failed");
  });
});

describe("WP-310: the budget at EMERGENCY_CANCEL, with the canceled count", () => {
  it("cancel-all is requested as clob.cancel_all at EMERGENCY_CANCEL for the credential's signer, and completed with the venue's canceled count", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const completions = vi.spyOn(RateLimitBudget.prototype, "complete");
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"), order("o-3"));
    await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    const cancelRequest = requests.mock.calls.find(([request]) => request.operationId === "clob.cancel_all");
    expect(cancelRequest?.[0]).toEqual({ operationId: "clob.cancel_all", priority: "EMERGENCY_CANCEL", signer: SIGNER });
    const completion = completions.mock.calls.find(([grant]) => (grant as Grant).operationId === "clob.cancel_all");
    expect((completion?.[1] as GrantCompletion).canceledCount).toBe(3);
    expect((completion?.[1] as GrantCompletion).error).toBeNull();
    // Every read went through the budget at RECONCILIATION_READ.
    const reads = requests.mock.calls.filter(([request]) => request.operationId === "clob.data_orders");
    expect(reads.length).toBe(2);
    expect(reads.every(([request]) => request.priority === "RECONCILIATION_READ")).toBe(true);
    expect(h.text()).toContain("clob.cancel_all debited 3 token(s) for orders canceled (D-21)");
  });

  it("an UNKNOWN cancel-all answer is completed with the listed count (a conservative over-debit), never with none", async () => {
    const completions = vi.spyOn(RateLimitBudget.prototype, "complete");
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"));
    h.venue.scripted.set("cancelAll", () => ({ kind: "UNKNOWN", error: transportFailure("CANCEL_ALL") }));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    const completion = completions.mock.calls.find(([grant]) => (grant as Grant).operationId === "clob.cancel_all");
    expect((completion?.[1] as GrantCompletion).canceledCount).toBe(2);
    expect((completion?.[1] as GrantCompletion).error).toEqual({ kind: "TRANSPORT_FAILURE", retryAfterSeconds: null });
    // The orders are still listed (the fake applied nothing), so the sweep cancels them by id.
    expect(h.venue.callsOf("cancelOrders")).toHaveLength(1);
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.text()).toContain("which orders DELETE /cancel-all canceled: its answer was lost or unreadable");
  });

  it("a 429 on cancel-all applies its Retry-After to the cancel bucket: the sweep waits it out", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    h.venue.scripted.set("cancelAll", () => ({ kind: "UNKNOWN", error: rateLimited("CANCEL_ALL", 4) }));
    await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    const [all] = h.venue.callsOf("cancelAll");
    const [sweep] = h.venue.callsOf("cancelOrders");
    expect(all).toBeDefined();
    expect(sweep).toBeDefined();
    expect((sweep?.at ?? 0) - (all?.at ?? 0)).toBeGreaterThanOrEqual(4_000);
    expect(h.text()).toMatch(/the cancel bucket waits until .* \(RETRY_AFTER\)/u);
  });

  it("the snapshot has no clob.cancel_all: nothing is sent, BUDGET_REFUSED", async () => {
    const snapshot = contractSnapshot();
    snapshot["operations"] = (snapshot["operations"] as { operationId: string }[]).filter((operation) => operation.operationId !== "clob.cancel_all");
    const h = harness({ configuration: testConfiguration({ rateLimitSnapshots: [snapshot] }) });
    h.venue.add(order("o-1"));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(outcome.exitName).toBe("BUDGET_REFUSED");
    expect(outcome.exitCode).toBe(EXIT_CODES.BUDGET_REFUSED);
    expect(h.venue.callsOf("cancelAll")).toEqual([]);
    expect(h.text()).toContain("NOT SENT: the rate-limit budget refused it (UNKNOWN_OPERATION");
  });
});

describe("WP-310: batch cancels split to at most the burst minus headroom", () => {
  it("300 orders left listed are swept by id in batches of 120, 120, 60: Standard's cancel burst 120 minus 0‰ headroom", async () => {
    const h = harness({ configuration: testConfiguration({ maxBudgetWaitMs: 60_000 }) });
    const listed = ids("s", 300);
    h.venue.add(...listed.map((id) => order(id)));
    for (const id of listed) h.venue.ignoreCancelAll.add(id);
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    const batches = h.venue.callsOf("cancelOrders").map((call) => (call.args[0] as string[]).length);
    expect(batches).toEqual([120, 120, 60]);
    expect(new Set(h.venue.callsOf("cancelOrders").flatMap((call) => call.args[0] as string[]))).toEqual(new Set(listed));
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.text()).toContain("in batches of at most 120 ids (tier Standard: cancel burst 120 minus 0‰ headroom");
  });

  it("with a 50‰ emergency headroom the batch is 114 (120 − 6): never one the budget would refuse as COST_EXCEEDS_CAPACITY", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const snapshot = contractSnapshot({ headroomPermille: { ORDER_HEARTBEAT: 0, EMERGENCY_CANCEL: 50, RECONCILIATION_READ: 50, RISK_REDUCING_ORDER: 100, STALE_QUOTE_CANCEL: 150, NEW_ORDER: 200, METADATA_ANALYTICS: 300 } });
    const h = harness({ configuration: testConfiguration({ rateLimitSnapshots: [snapshot], maxBudgetWaitMs: 60_000 }) });
    const listed = ids("h", 250);
    h.venue.add(...listed.map((id) => order(id)));
    for (const id of listed) h.venue.ignoreCancelAll.add(id);
    await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(h.venue.callsOf("cancelOrders").map((call) => (call.args[0] as string[]).length)).toEqual([114, 114, 22]);
    const refused = requests.mock.results.filter((result) => result.type === "return" && (result.value as { kind: string }).kind === "REFUSED");
    expect(refused).toEqual([]);
  });

  it("every batch request names its entry count, at EMERGENCY_CANCEL", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const h = harness({ configuration: testConfiguration({ maxBudgetWaitMs: 60_000 }) });
    const listed = ids("e", 130);
    h.venue.add(...listed.map((id) => order(id)));
    for (const id of listed) h.venue.ignoreCancelAll.add(id);
    await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    const batches = requests.mock.calls.filter(([request]) => request.operationId === "clob.cancel_orders").map(([request]) => request);
    expect(batches).toEqual([
      { operationId: "clob.cancel_orders", priority: "EMERGENCY_CANCEL", signer: SIGNER, entries: 120 },
      { operationId: "clob.cancel_orders", priority: "EMERGENCY_CANCEL", signer: SIGNER, entries: 10 },
    ]);
  });
});

describe("D-21: cancel debt is planned for and waited out", () => {
  it("after canceling 250 orders on Standard, a 10-id sweep waits for the cancel bucket's debt (about (250 + 10) / 80 s)", async () => {
    const h = harness();
    const listed = ids("d", 260);
    h.venue.add(...listed.map((id) => order(id)));
    for (const id of listed.slice(250)) h.venue.ignoreCancelAll.add(id);
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(outcome.exitName).toBe("COMPLETED");
    const [all] = h.venue.callsOf("cancelAll");
    const [sweep] = h.venue.callsOf("cancelOrders");
    expect((sweep?.args[0] as string[]).length).toBe(10);
    // The cold-start bucket is empty: cancel-all (1 token) waits 13 ms; the debit leaves about -250 tokens;
    // a 10-token batch is admissible once the level reaches 10: (10 + 250) / 80 tokens/s = 3.25 s.
    expect((sweep?.at ?? 0) - (all?.at ?? 0)).toBeGreaterThanOrEqual(3_250);
    expect((sweep?.at ?? 0) - (all?.at ?? 0)).toBeLessThan(3_400);
    // The plan printed the debt before acting.
    expect(h.text()).toContain("cancel debt (D-21): tier Standard (cancel burst 120, 80 tokens/s, negative balance allowed)");
    expect(h.text()).toMatch(/after canceling the 260 listed order\(s\) the local bucket would stand at about -260 tokens/u);
  });

  it("a sweep that would wait longer than maxBudgetWaitMs is not sent; the orders still listed are reported: NOT_ALL_CANCELED", async () => {
    const h = harness({ configuration: testConfiguration({ maxBudgetWaitMs: 1_000 }) });
    const listed = ids("w", 210);
    h.venue.add(...listed.map((id) => order(id)));
    for (const id of listed.slice(200)) h.venue.ignoreCancelAll.add(id);
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(h.venue.callsOf("cancelOrders")).toEqual([]);
    expect(outcome.exitName).toBe("NOT_ALL_CANCELED");
    expect(outcome.exitCode).toBe(EXIT_CODES.NOT_ALL_CANCELED);
    expect(h.text()).toContain("the cancel bucket would not admit it within maxBudgetWaitMs (1000 ms)");
    expect(h.text()).toContain("venue truth after the by-id sweep: 10 open order(s) listed");
  });
});

describe("an answer that never comes is UNKNOWN after venueAnswerBoundMs, never a hang", () => {
  it("DELETE /cancel-all never answers: after the bound it is UNKNOWN (counted at the listed orders), and the by-id sweep still runs", async () => {
    const completions = vi.spyOn(RateLimitBudget.prototype, "complete");
    const h = harness({ configuration: testConfiguration({ venueAnswerBoundMs: 20 }) });
    h.venue.add(order("o-1"), order("o-2"));
    h.venue.scripted.set("cancelAll", () => new Promise(() => undefined));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(h.text()).toContain("DELETE /cancel-all: sent after waiting 13 ms for the rate-limit budget; NO ANSWER within venueAnswerBoundMs: UNKNOWN");
    const completion = completions.mock.calls.find(([grant]) => (grant as Grant).operationId === "clob.cancel_all");
    expect((completion?.[1] as GrantCompletion).error).toEqual({ kind: "UNANSWERED", retryAfterSeconds: null });
    expect((completion?.[1] as GrantCompletion).canceledCount).toBe(2);
    expect(h.venue.callsOf("cancelOrders")).toHaveLength(1);
    expect(outcome.exitName).toBe("COMPLETED");
  });

  it("the open-orders read never answers: reported as not read, never as empty; the cancel is still sent; the result is unverified", async () => {
    const h = harness({ configuration: testConfiguration({ venueAnswerBoundMs: 20 }) });
    h.venue.add(order("o-1"));
    h.venue.scripted.set("listOpenOrders", () => new Promise(() => undefined));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(h.text()).toContain("venue truth now: NOT READ (listOpenOrders got no answer within venueAnswerBoundMs (20 ms))");
    expect(h.venue.callsOf("cancelAll")).toHaveLength(1);
    expect(h.text()).toContain("the account's open orders after the cancels: the read failed");
    expect(outcome.exitName).toBe("COMPLETED");
  });
});

describe("the RESULT and the exit say exactly what happened", () => {
  it("every not-canceled order is listed with its reason (ADR-008 §6), and still-listed orders are NOT_ALL_CANCELED", async () => {
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"));
    h.venue.resist.add("o-2");
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(h.text()).toContain("NOT CANCELED o-2: Order already matched");
    expect(outcome.exitName).toBe("NOT_ALL_CANCELED");
    const result = h.audit.records.at(-1)?.detail;
    expect(result?.["stillListed"]).toEqual({ count: 1, ids: ["o-2"], truncated: false });
  });

  it("the venue refuses every cancel unapplied: VENUE_REFUSED", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    h.venue.scripted.set("cancelAll", () => ({ kind: "REFUSED", error: refusedUnapplied("CANCEL_ALL") }));
    h.venue.scripted.set("cancelOrders", () => ({ kind: "REFUSED", error: refusedUnapplied("CANCEL_ORDERS") }));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(outcome.exitName).toBe("VENUE_REFUSED");
    expect(h.text()).toContain("answer REFUSED (POST_ONLY_MODE, HTTP 503, effect NOT_APPLIED)");
  });

  it("an UNKNOWN answer and no readable state afterwards: UNKNOWN", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    h.venue.scripted.set("cancelAll", () => ({ kind: "UNKNOWN", error: null }));
    let read = 0;
    h.venue.scripted.set("listOpenOrders", () => {
      read += 1;
      return read === 1 ? { route: "/data/orders", complete: true, orders: [] } : Promise.reject(new Error("down"));
    });
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(outcome.exitName).toBe("UNKNOWN");
    expect(outcome.exitCode).toBe(EXIT_CODES.UNKNOWN);
  });

  it("an incomplete final list is not proof of anything: UNKNOWN", async () => {
    const h = harness();
    h.venue.add(order("o-1"));
    h.venue.scripted.set("cancelAll", () => ({ kind: "UNKNOWN", error: null }));
    h.venue.scripted.set("listOpenOrders", () => ({ route: "/data/orders", complete: false, orders: [] }));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(outcome.exitName).toBe("UNKNOWN");
    expect(h.text()).toContain("the account's full open-order list: the venue marked it incomplete");
  });

  it("the OUTCOME record carries every attempt (totals, and each attempt itemized by counts) and the canceled ids, bounded, with no secret", async () => {
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"));
    await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    const outcome = h.audit.records.at(-1) as AuditRecord;
    expect(outcome.phase).toBe("OUTCOME");
    expect(outcome.detail["exit"]).toBe("COMPLETED");
    expect(outcome.detail["attempts"]).toEqual({
      count: 1,
      sent: 1,
      answers: { COMPLETED: 1, NOT_SENT: 0, REFUSED: 0, UNKNOWN: 0 },
      unanswered: 0,
      requestedIds: 0,
      canceledCountPassed: 2,
      canceledCountMissing: 0,
      resplit: 0,
      itemized: [
        expect.objectContaining({ endpoint: "DELETE /cancel-all", operationId: "clob.cancel_all", requested: null, sent: true, answer: "COMPLETED", canceled: 2, notCanceled: 0, canceledCount: 2, resplitTo: null }),
      ],
      truncated: false,
    });
    expect(outcome.detail["canceled"]).toEqual({ count: 2, ids: ["o-1", "o-2"], truncated: false });
    expect(outcome.detail["notCanceled"]).toEqual({ count: 0, entries: [], truncated: false });
  });

  it("D8 (WP-330 r1, WP330-V1-07): exit 0 is COMPLETED either way, and the OUTCOME record says whether a complete read verified it", async () => {
    const verified = harness();
    verified.venue.add(order("o-1"));
    expect((await runOpsCli(verified.deps(cancelAll(...CONFIRM)))).exitName).toBe("COMPLETED");
    expect(verified.audit.records.at(-1)?.detail["verified"]).toBe(true);

    // The answers alone: every answer COMPLETED, nothing named not canceled, and no verification read (runbook rule 3).
    const unverified = harness();
    unverified.venue.add(order("o-1"));
    let reads = 0;
    unverified.venue.scripted.set("listOpenOrders", () => {
      reads += 1;
      return reads === 1 ? { route: "/data/orders", complete: true, orders: [] } : Promise.reject(transportFailure("FETCH_ORDER"));
    });
    expect((await runOpsCli(unverified.deps(cancelAll(...CONFIRM)))).exitName).toBe("COMPLETED");
    expect(unverified.audit.records.at(-1)?.detail["verified"]).toBe(false);
    expect(unverified.text()).toContain("the account's open orders after the cancels: the read failed");
  });
});

describe("WP-330 r4 (CX330-R4-01): the sweep's batch size is recomputed before every batch (WP-310 follow_up 4), through WP-260's client and WP-310's real budget", () => {
  /** Bronze (cancel burst 240) assumed by the operator's snapshot: a venue that reports Standard (120) LOWERS the tier. */
  const bronzeAssumed = (): ReturnType<typeof testConfiguration> =>
    testConfiguration({ rateLimitSnapshots: [contractSnapshot({ assumedSignerTier: "Bronze" })], maxBudgetWaitMs: 60_000 });

  /**
   * The cancels are WP-260's client over its fake SDK and key-less mock signer (as in secure-client.test.ts); the
   * reads are the harness's. `reportTier` delivers a tier on the cancel bucket the way the SDK's `onRateLimitUpdate`
   * does (`Poly-RateLimit-Tier`), through the listener WP-260 handed the SDK, to the CLI's real budget.
   */
  function secureTierVenue(h: Harness, script: (reportTier: (tier: string) => void) => FakeSdkScript): EmergencyVenueFactory {
    let listener: ((tier: string) => void) | null = null;
    const reportTier = (tier: string): void => {
      if (listener === null) throw new Error("the SDK was never built");
      listener(tier);
    };
    const sdk = createFakeSdkFactory(script(reportTier));
    return {
      open: async ({ gate, onRateLimitUpdate }: { readonly gate: SignerGateContext; readonly onRateLimitUpdate: Parameters<EmergencyVenueFactory["open"]>[0]["onRateLimitUpdate"] }) => {
        const cancels: SecureVenueClient = await createSecureVenueClientForTesting({ runModeContext: { ...gate }, signer: createMockSignerHandle().handle, onRateLimitUpdate }, sdk.factory);
        const handed = sdk.recorder.factoryCalls[0]?.onRateLimitUpdate;
        if (handed === undefined) throw new Error("WP-260 handed the SDK no rate-limit listener");
        listener = (tier) => handed({ bucket: "cancel", tier, warning: false });
        return { kind: "OPEN" as const, venue: { cancels, reads: h.venue.reads } };
      },
    };
  }

  /** The SDK's cancelOrders over the harness's orders: every id canceled; the batch sizes recorded. */
  function cancelOrdersApplying(h: Harness, batches: number[], after?: (batch: number) => void): NonNullable<FakeSdkScript["cancelOrders"]> {
    return (request: { orderIds: string[] }) => {
      batches.push(request.orderIds.length);
      for (const id of request.orderIds) {
        const entry = h.venue.orders.get(id);
        if (entry !== undefined) entry.status = "CANCELED";
      }
      after?.(batches.length);
      return { canceled: request.orderIds, notCanceled: {} } as never;
    };
  }

  function batchRequests(requests: MockInstance<RateLimitBudget["request"]>): unknown[] {
    return requests.mock.calls.filter(([request]) => request.operationId === "clob.cancel_orders").map(([request]) => request);
  }

  function refusedRequests(requests: MockInstance<RateLimitBudget["request"]>, polls: MockInstance<RateLimitBudget["poll"]>): string[] {
    const atRequest = requests.mock.results.flatMap((result) => (result.type === "return" && result.value.kind === "REFUSED" ? [result.value.refusal.code] : []));
    const atPoll = polls.mock.results.flatMap((result) => (result.type === "return" ? result.value.flatMap((event) => (event.kind === "REFUSED" ? [event.refusal.code] : [])) : []));
    return [...atRequest, ...atPoll];
  }

  it("a LOWER tier reported on the cancel-all's own (lost) answer: 300 orders are swept at Standard's 120 (120, 120, 60), every order canceled, nothing refused", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const polls = vi.spyOn(RateLimitBudget.prototype, "poll");
    const completions = vi.spyOn(RateLimitBudget.prototype, "complete");
    const h = harness({ configuration: bronzeAssumed() });
    const listed = ids("t", 300);
    h.venue.add(...listed.map((id) => order(id)));
    const batches: number[] = [];
    const venues = secureTierVenue(h, (reportTier) => ({
      cancelAll: () => {
        reportTier("Standard");
        throw new Error("simulated lost cancel-all answer");
      },
      cancelOrders: cancelOrdersApplying(h, batches),
    }));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM), { venues }));
    expect(batches).toEqual([120, 120, 60]);
    expect(h.venue.open()).toEqual([]);
    expect(outcome.exitName).toBe("COMPLETED");
    expect(refusedRequests(requests, polls)).toEqual([]);
    expect(h.text()).not.toContain("COST_EXCEEDS_CAPACITY");
    // The plan said Bronze's 240; the sweep followed the tier the venue reported, and said so.
    expect(h.text()).toContain("in batches of at most 240 ids (tier Bronze: cancel burst 240 minus 0‰ headroom");
    expect(h.text()).toContain("the by-id batch size changed after the plan: at most 120 ids per DELETE /orders now (tier Standard: cancel burst 120 minus 0‰ headroom)");
    // EMERGENCY_CANCEL, the entry count, and the canceled count, batch by batch (WP-310 follow_up 4, OP-R1-09).
    expect(batchRequests(requests)).toEqual([120, 120, 60].map((entries) => ({ operationId: "clob.cancel_orders", priority: "EMERGENCY_CANCEL", signer: MOCK_SIGNER_ADDRESS, entries })));
    const counts = completions.mock.calls.filter(([grant]) => (grant as Grant).operationId === "clob.cancel_orders").map(([, completion]) => (completion as GrantCompletion).canceledCount);
    expect(counts).toEqual([120, 120, 60]);
    expect(phases(h.audit.records)).toEqual(["INVOKED", "ACTING", "OUTCOME"]);
    expect(h.audit.records.at(-1)?.detail["attempts"]).toMatchObject({ count: 4, sent: 4, requestedIds: 300, resplit: 0 });
  });

  it("the same with 200 orders (more than Standard's 120, fewer than Bronze's 240): 120, then 80", async () => {
    const h = harness({ configuration: bronzeAssumed() });
    h.venue.add(...ids("u", 200).map((id) => order(id)));
    const batches: number[] = [];
    const venues = secureTierVenue(h, (reportTier) => ({
      cancelAll: () => {
        reportTier("Standard");
        throw new Error("simulated lost cancel-all answer");
      },
      cancelOrders: cancelOrdersApplying(h, batches),
    }));
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM), { venues }));
    expect(batches).toEqual([120, 80]);
    expect(h.venue.open()).toEqual([]);
    expect(outcome.exitName).toBe("COMPLETED");
  });

  it("a LOWER tier reported on the FIRST batch's answer: the batches after it are split at the new size (240, then 120, 120, 120)", async () => {
    const requests = vi.spyOn(RateLimitBudget.prototype, "request");
    const polls = vi.spyOn(RateLimitBudget.prototype, "poll");
    const h = harness({ configuration: bronzeAssumed() });
    const listed = ids("v", 600);
    h.venue.add(...listed.map((id) => order(id)));
    const batches: number[] = [];
    let report: ((tier: string) => void) | null = null;
    const venues = secureTierVenue(h, (reportTier) => {
      report = reportTier;
      return {
        cancelAll: () => {
          throw new Error("simulated lost cancel-all answer");
        },
        cancelOrders: cancelOrdersApplying(h, batches, (batch) => {
          if (batch === 1) report?.("Standard");
        }),
      };
    });
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM), { venues }));
    expect(batches).toEqual([240, 120, 120, 120]);
    expect(h.venue.open()).toEqual([]);
    expect(outcome.exitName).toBe("COMPLETED");
    expect(refusedRequests(requests, polls)).toEqual([]);
  });

  /** The dated snapshot, then the same with a 500‰ emergency headroom taking effect 1 s after T0: the batch falls from 120 to 60. */
  function headroomRaisedAt(effectiveMs: number): ReturnType<typeof testConfiguration> {
    // The ladder's headroom may not fall from one class to the next (WP-310): every class below the emergency one is raised with it.
    const later = contractSnapshot({ headroomPermille: { ORDER_HEARTBEAT: 0, EMERGENCY_CANCEL: 500, RECONCILIATION_READ: 500, RISK_REDUCING_ORDER: 500, STALE_QUOTE_CANCEL: 500, NEW_ORDER: 500, METADATA_ANALYTICS: 500 } });
    later["snapshotId"] = "wp330-r4-test-emergency-headroom";
    later["effectiveFrom"] = new Date(effectiveMs).toISOString();
    return testConfiguration({ rateLimitSnapshots: [contractSnapshot(), later], maxBudgetWaitMs: 60_000 });
  }

  it("the snapshot in effect changes WHILE a batch waits for its grant: the budget refuses it unsent (COST_EXCEEDS_CAPACITY), and only that batch is rebuilt at the new size; every id is sent exactly once", async () => {
    const h = harness({ configuration: headroomRaisedAt(T0 + 1_000) });
    const listed = ids("c", 300);
    h.venue.add(...listed.map((id) => order(id)));
    for (const id of listed) h.venue.ignoreCancelAll.add(id);
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    const sent = h.venue.callsOf("cancelOrders").map((call) => call.args[0] as string[]);
    expect(sent.map((batch) => batch.length)).toEqual([60, 60, 60, 60, 60]);
    expect(sent.flat()).toEqual(listed); // in order, each once: the cursor moved only past ids a sent request carried
    expect(h.venue.open()).toEqual([]);
    expect(outcome.exitName).toBe("COMPLETED");
    expect(h.text()).toContain(
      "DELETE /orders (120 ids): NOT SENT: the rate-limit budget refused it (COST_EXCEEDS_CAPACITY: the token cost exceeds the bucket's burst capacity: split the request); the cancel bucket's capacity fell while it waited, so its ids were split again into batches of at most 60 (below)",
    );
    expect(h.text()).toContain("the by-id batch size changed after the plan: at most 60 ids per DELETE /orders now (tier Standard: cancel burst 120 minus 500‰ headroom)");
    expect(h.text()).not.toContain("the by-id sweep stopped");
    const attempts = h.audit.records.at(-1)?.detail["attempts"] as { itemized: Record<string, unknown>[] };
    expect(attempts).toMatchObject({ count: 7, sent: 6, requestedIds: 300, resplit: 1, truncated: false });
    expect(attempts.itemized[1]).toMatchObject({ endpoint: "DELETE /orders", requested: 120, sent: false, resplitTo: 60 });
    expect(attempts.itemized.filter((entry) => entry["resplitTo"] !== null)).toHaveLength(1);
  });

  it("a rebuilt batch does not decide an UNVERIFIED exit: the final read fails, every sent answer is COMPLETED with nothing not canceled, so COMPLETED", async () => {
    const h = harness({ configuration: headroomRaisedAt(T0 + 1_000) });
    const listed = ids("n", 300);
    h.venue.add(...listed.map((id) => order(id)));
    for (const id of listed) h.venue.ignoreCancelAll.add(id);
    let reads = 0;
    h.venue.scripted.set("listOpenOrders", () => {
      reads += 1;
      if (reads >= 3) return Promise.reject(transportFailure("FETCH_ORDER"));
      return {
        route: "/data/orders",
        complete: true,
        orders: h.venue.open().map(({ venueOrderId, tokenId, side, price, originalSize, sizeMatched, status }) => ({ venueOrderId, tokenId, side, price, originalSize, sizeMatched, status })),
      };
    });
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(h.venue.callsOf("cancelOrders").map((call) => (call.args[0] as string[]).length)).toEqual([60, 60, 60, 60, 60]);
    expect(h.audit.records.at(-1)?.detail).toMatchObject({ verified: false, attempts: { resplit: 1 } });
    expect(outcome.exitName).toBe("COMPLETED");
  });

  /** Refuse every DELETE /orders at admission, as WP-310 does a batch above its capacity; `refusals` counts them. */
  function refuseEveryBatch(): { readonly refusals: () => number } {
    let refusals = 0;
    const acquire = EmergencyBudget.prototype.acquire;
    vi.spyOn(EmergencyBudget.prototype, "acquire").mockImplementation(function (this: EmergencyBudget, request): Promise<AcquireResult> {
      if (request.operationId !== "clob.cancel_orders") return acquire.call(this, request);
      refusals += 1;
      return Promise.resolve({ kind: "REFUSED", code: "COST_EXCEEDS_CAPACITY", message: "the token cost exceeds the bucket's burst capacity: split the request" });
    });
    return { refusals: () => refusals };
  }

  it("a COST_EXCEEDS_CAPACITY refusal while the capacity has NOT fallen is not retried at the same size: the sweep stops at once and says why", async () => {
    const refused = refuseEveryBatch();
    const h = harness();
    // More orders than one batch holds, so the refused batch is exactly the capacity (120): not rebuilt at 120 again.
    h.venue.add(...ids("a", 130).map((id) => order(id)));
    for (const entry of h.venue.open()) h.venue.ignoreCancelAll.add(entry.venueOrderId);
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(refused.refusals()).toBe(1);
    expect(h.text()).toContain("DELETE /orders (120 ids): NOT SENT: the rate-limit budget refused it (COST_EXCEEDS_CAPACITY");
    expect(h.text()).toContain("the by-id sweep stopped: the rate-limit budget refused it (COST_EXCEEDS_CAPACITY");
    expect(h.audit.records.at(-1)?.detail["attempts"]).toMatchObject({ count: 2, resplit: 0 });
    expect(outcome.exitName).toBe("NOT_ALL_CANCELED");
  });

  it(`the rebuilding is bounded: a capacity that keeps falling is followed at most MAX_SWEEP_RESPLITS (${String(MAX_SWEEP_RESPLITS)}) times, then the sweep stops and says so`, async () => {
    const refused = refuseEveryBatch();
    // Each refusal lowers the capacity by one id: every refused batch could be rebuilt smaller, forever but for the bound.
    const capacity = EmergencyBudget.prototype.batchCapacity;
    vi.spyOn(EmergencyBudget.prototype, "batchCapacity").mockImplementation(function (this: EmergencyBudget) {
      const real = capacity.call(this);
      return "problem" in real ? real : { ...real, maxEntries: real.maxEntries - refused.refusals() };
    });
    const h = harness();
    h.venue.add(...ids("b", 130).map((id) => order(id)));
    for (const entry of h.venue.open()) h.venue.ignoreCancelAll.add(entry.venueOrderId);
    const outcome = await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    expect(refused.refusals()).toBe(MAX_SWEEP_RESPLITS + 1);
    expect(h.text()).toContain(`; ${String(MAX_SWEEP_RESPLITS)} batches were already split again in this sweep`);
    expect(h.audit.records.at(-1)?.detail["attempts"]).toMatchObject({ count: MAX_SWEEP_RESPLITS + 2, sent: 1, resplit: MAX_SWEEP_RESPLITS });
    expect(h.venue.callsOf("cancelOrders")).toEqual([]);
    expect(outcome.exitName).toBe("NOT_ALL_CANCELED");
  });
});
