/**
 * cancel-all (handoff §14.2; ADR-008 §6; work-plan WP-330 acceptance 1:
 * "cancel-all does not require trader state"), and WP-310's obligations on
 * WP-330 (follow_up 4, OP-R1-09): the emergency class, the canceled count,
 * D-21 debt, and batch cancels split to at most the burst minus headroom.
 */

import { RateLimitBudget, type Grant, type GrantCompletion } from "@polymarket-bot/polymarket-secure";
import { installNetworkTripwire, type NetworkTripwire } from "@polymarket-bot/polymarket-secure/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditMirror, AuditRecord } from "./audit-log.js";
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
  testConfiguration,
  transportFailure,
} from "./harness.test-support.js";
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

  it("the OUTCOME record carries every attempt, bounded, with no secret", async () => {
    const h = harness();
    h.venue.add(order("o-1"), order("o-2"));
    await runOpsCli(h.deps(cancelAll(...CONFIRM)));
    const outcome = h.audit.records.at(-1) as AuditRecord;
    expect(outcome.phase).toBe("OUTCOME");
    expect(outcome.detail["exit"]).toBe("COMPLETED");
    expect(outcome.detail["attempts"]).toEqual([
      expect.objectContaining({ endpoint: "DELETE /cancel-all", operationId: "clob.cancel_all", sent: true, answer: "COMPLETED", canceledCount: 2, canceled: { count: 2, ids: ["o-1", "o-2"], truncated: false } }),
    ]);
  });
});
