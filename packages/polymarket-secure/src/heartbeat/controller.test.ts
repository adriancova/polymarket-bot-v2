/**
 * WP-320 / ADR-033 D1–D4 and D6: the order-heartbeat controller, against a
 * fake transport, a manual clock and WP-310's REAL budget over the contract
 * snapshot. Nothing here reaches a network: the network tripwire is installed
 * for every test and must record no attempt.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SignerBoundaryRefusal } from "../errors.js";
import type { BudgetRequest, RequestDecision } from "../rate-limit/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../testing/network-tripwire.js";

import { createOrderHeartbeatController, HeartbeatConfigurationError, type CreateOrderHeartbeatControllerOptions, type HeartbeatBudget } from "./controller.js";
import {
  budgetFrom,
  CONTRACT_SNAPSHOT_PATH,
  EventLog,
  FakeHeartbeatTransport,
  invalidId,
  LIVE_SHAPED_CONTEXT,
  ManualTime,
  ok,
  SwitchableGate,
} from "./fakes.test-support.js";
import { HEARTBEAT_CADENCE_MS, HEARTBEAT_OPERATION_ID, HEARTBEAT_PRIORITY, HEARTBEAT_TIMEOUT_MS } from "./venue-facts.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SNAPSHOT: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, CONTRACT_SNAPSHOT_PATH), "utf8"));

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

interface Harness {
  readonly time: ManualTime;
  readonly transport: FakeHeartbeatTransport;
  readonly gate: SwitchableGate;
  readonly log: EventLog;
  readonly persisted: string[];
  readonly budgetCalls: { readonly input: BudgetRequest; readonly atMs: number }[];
  readonly controller: ReturnType<typeof createOrderHeartbeatController>;
}

function harness(overrides: Partial<CreateOrderHeartbeatControllerOptions> = {}, budget: HeartbeatBudget = budgetFrom(SNAPSHOT)): Harness {
  const time = new ManualTime();
  const transport = new FakeHeartbeatTransport(time);
  const gate = new SwitchableGate();
  const log = new EventLog();
  const persisted: string[] = [];
  const budgetCalls: { readonly input: BudgetRequest; readonly atMs: number }[] = [];
  const spied: HeartbeatBudget = {
    request: (input, atMs) => {
      budgetCalls.push({ input, atMs });
      return budget.request(input, atMs);
    },
    withdraw: (ticketId) => budget.withdraw(ticketId),
    complete: (grant, completion) => budget.complete(grant, completion),
  };
  const controller = createOrderHeartbeatController({
    runModeContext: LIVE_SHAPED_CONTEXT,
    transport,
    gate,
    budget: spied,
    clock: time,
    timers: time,
    onEvent: log.listener,
    heartbeatIds: {
      persist: async (id) => {
        persisted.push(id);
        return true;
      },
    },
    ...overrides,
  });
  return { time, transport, gate, log, persisted, budgetCalls, controller };
}

/** Start, and let the first heartbeat (sent at once) be answered. */
async function started(h: Harness): Promise<void> {
  h.controller.start();
  await h.time.advance(0);
}

describe("ADR-033 D4: the controller exists only in a live run mode (assertSignerGate first)", () => {
  const tripwireTarget = (): { touched: string[]; target: object } => {
    const touched: string[] = [];
    const target = new Proxy(
      {},
      {
        get: (_target, key) => {
          touched.push(String(key));
          return undefined;
        },
        getOwnPropertyDescriptor: (_target, key) => {
          touched.push(String(key));
          return undefined;
        },
      },
    );
    return { touched, target };
  };

  for (const context of [
    { runMode: "PAPER", maximumRunMode: "PAPER", allowRealOrders: false },
    { runMode: "PAPER", maximumRunMode: "LIVE", allowRealOrders: true },
    { runMode: "BACKTEST", maximumRunMode: "LIVE", allowRealOrders: true },
    { runMode: "SHADOW", maximumRunMode: "LIVE", allowRealOrders: true },
    { runMode: "REPLAY", maximumRunMode: "LIVE", allowRealOrders: true },
    { runMode: "LIVE", maximumRunMode: "LIVE_MICRO", allowRealOrders: true },
    { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: false },
    { runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: "true" },
    undefined,
  ]) {
    it(`refuses ${JSON.stringify(context)} with SignerBoundaryRefusal, before any port is read`, () => {
      const transport = tripwireTarget();
      const gate = tripwireTarget();
      const budget = tripwireTarget();
      expect(() =>
        createOrderHeartbeatController({
          runModeContext: context,
          transport: transport.target as never,
          gate: gate.target as never,
          budget: budget.target as never,
          clock: { monotonicMs: () => 0, epochMs: () => 0 },
          timers: { setTimeout: () => 0, clearTimeout: () => undefined },
          onEvent: () => undefined,
        }),
      ).toThrow(SignerBoundaryRefusal);
      expect(transport.touched).toEqual([]);
      expect(gate.touched).toEqual([]);
      expect(budget.touched).toEqual([]);
    });
  }

  it("builds in a live-shaped context, and refuses a malformed option with a fixed code", () => {
    expect(() => harness()).not.toThrow();
    expect(() => harness({ transport: {} as never })).toThrow(HeartbeatConfigurationError);
    expect(() => harness({ initialHeartbeatId: "bad\nid" })).toThrow(HeartbeatConfigurationError);
    expect(() => harness({ responseTimeoutMs: 0 })).toThrow(HeartbeatConfigurationError);
  });
});

describe("ADR-033 D6: the controller starts lapsed", () => {
  it("reports LAPSE_STARTED (STARTUP) before anything is sent, and is lapsed until the first confirmation", async () => {
    const h = harness();
    expect(h.controller.isLapsed()).toBe(true);
    h.controller.start();
    expect(h.log.kinds()[0]).toBe("LAPSE_STARTED");
    expect(h.log.of("LAPSE_STARTED")[0]?.cause).toBe("STARTUP");
    expect(h.transport.requests).toHaveLength(0);
    expect(h.controller.isLapsed()).toBe(true);
    await h.time.advance(0);
    expect(h.transport.requests).toHaveLength(1);
    expect(h.log.of("LAPSE_ENDED")).toHaveLength(1);
    expect(h.controller.isLapsed()).toBe(false);
  });
});

describe("ADR-033 D1 item 1: the protocol as the guide gives it (S-D17)", () => {
  it("bootstraps with an empty id, then carries each returned id, every 5 s from the previous send", async () => {
    const h = harness();
    h.transport.script.push(ok("id-a"), ok("id-b"), ok("id-c"));
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(h.transport.requests.map((r) => r.heartbeatId)).toEqual(["", "id-a", "id-b"]);
    const times = h.transport.requests.map((r) => r.atMs);
    expect([(times[1] ?? 0) - (times[0] ?? 0), (times[2] ?? 0) - (times[1] ?? 0)]).toEqual([HEARTBEAT_CADENCE_MS, HEARTBEAT_CADENCE_MS]);
    expect(h.persisted).toEqual(["id-a", "id-b", "id-c"]);
  });

  it("resumes a persisted id (ADR-008 §4) instead of bootstrapping", async () => {
    const h = harness({ initialHeartbeatId: "persisted-id-7" });
    await started(h);
    expect(h.transport.requests[0]?.heartbeatId).toBe("persisted-id-7");
  });

  it("a 400 with the expected id is answered by ONE new request with that id, at once", async () => {
    const h = harness();
    h.transport.script.push(ok("id-a"), invalidId("expected-1"), ok("id-b"));
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(h.transport.requests.map((r) => r.heartbeatId)).toEqual(["", "id-a", "expected-1"]);
    expect(h.transport.requests[2]?.atMs).toBe(h.transport.requests[1]?.atMs);
    expect(h.log.of("HEARTBEAT_SENT").map((e) => e.recovery)).toEqual([false, false, true]);
    expect(h.log.of("LIVE_FENCING_CONFLICT")).toHaveLength(0);
  });

  it("a second 400 in a row is not retried at once, and raises LIVE_FENCING_CONFLICT (ADR-008 §4)", async () => {
    const h = harness();
    h.transport.script.push(ok("id-a"), invalidId("expected-1"), invalidId("expected-2"), ok("id-b"));
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(h.transport.requests.map((r) => r.heartbeatId)).toEqual(["", "id-a", "expected-1"]);
    expect(h.log.of("LIVE_FENCING_CONFLICT")).toHaveLength(1);
    // The next cadence tick carries the latest expected id.
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(h.transport.requests.map((r) => r.heartbeatId)).toEqual(["", "id-a", "expected-1", "expected-2"]);
  });

  it("never puts a heartbeat id in an event", async () => {
    const h = harness();
    h.transport.script.push(ok("secret-looking-id-1"), invalidId("secret-looking-id-2"));
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS * 3);
    expect(JSON.stringify(h.log.events)).not.toContain("secret-looking-id");
  });
});

describe("ADR-033 D1 items 2 and 5: the gate (work-plan acceptance: an unhealthy process that is still running stops the heartbeat)", () => {
  it("a refused gate stops every further heartbeat, and the lapse names the gate's reasons", async () => {
    const h = harness();
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    const sent = h.transport.requests.length;
    expect(sent).toBe(2);
    h.gate.answer = { permitted: false, reasons: ["HEALTH_MARKET_DATA_STALE"] };
    await h.time.advance(HEARTBEAT_CADENCE_MS * 6);
    expect(h.transport.requests).toHaveLength(sent);
    const lapse = h.log.of("LAPSE_STARTED").at(-1);
    expect(lapse?.cause).toBe("GATE_REFUSED");
    expect(lapse?.gateReasons).toEqual(["HEALTH_MARKET_DATA_STALE"]);
    expect(h.controller.isLapsed()).toBe(true);
  });

  for (const [name, answer] of [
    ["permitted: false", { permitted: false }],
    ["permitted: 'true' (a string)", { permitted: "true" }],
    ["permitted: 1", { permitted: 1 }],
    ["an accessor", Object.defineProperty({}, "permitted", { get: () => true, enumerable: true })],
    ["an inherited permitted", Object.create({ permitted: true }) as object],
    ["a promise of permission", Promise.resolve({ permitted: true })],
    ["undefined", undefined],
    ["true itself", true],
  ] as const) {
    it(`an unconfirmed gate answer (${name}) sends nothing`, async () => {
      const h = harness();
      h.gate.answer = answer;
      await started(h);
      await h.time.advance(HEARTBEAT_CADENCE_MS * 3);
      expect(h.transport.requests).toHaveLength(0);
      expect(h.log.of("HEARTBEAT_UNCONFIRMED").every((e) => e.reason === "GATE_REFUSED")).toBe(true);
    });
  }

  it("a gate that throws sends nothing", async () => {
    const h = harness({
      gate: {
        evaluate: () => {
          throw new Error("health store unreachable");
        },
      },
    });
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS * 2);
    expect(h.transport.requests).toHaveLength(0);
    expect(h.log.of("HEARTBEAT_UNCONFIRMED")[0]?.gateReasons).toEqual(["GATE_THREW"]);
  });

  it("a refused gate abandons a pending 400 recovery (ADR-008 §2)", async () => {
    const h = harness();
    h.transport.script.push(ok("id-a"), { defer: true });
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(h.transport.requests).toHaveLength(2);
    // The process becomes unhealthy while the request is in flight; then the venue answers 400.
    h.gate.answer = { permitted: false, reasons: ["FENCE_NOT_HELD"] };
    h.transport.resolveDeferred({ kind: "RESPONSE", httpStatus: 400, body: { error_msg: "Invalid Heartbeat ID", heartbeat_id: "expected-9" } });
    await h.time.advance(HEARTBEAT_CADENCE_MS * 3);
    expect(h.transport.requests).toHaveLength(2);
  });

  it("sends again only once the gate passes again", async () => {
    const h = harness();
    h.gate.answer = { permitted: false };
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS * 2);
    expect(h.transport.requests).toHaveLength(0);
    h.gate.answer = { permitted: true };
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(h.transport.requests).toHaveLength(1);
  });
});

describe("ADR-033 D6: confirmation and the lapse clock", () => {
  it("measures the lapse from the SEND time of the last confirmed heartbeat, not its confirmation", async () => {
    const h = harness();
    h.transport.script.push({ defer: true });
    h.controller.start();
    await h.time.advance(0);
    const sentAt = h.transport.requests[0]?.atMs ?? 0;
    await h.time.advance(3_000);
    h.transport.resolveDeferred({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: "id-a" } });
    await h.time.advance(0);
    expect(h.log.of("LAPSE_ENDED")).toHaveLength(1);
    h.gate.answer = { permitted: false };
    await h.time.advance(sentAt + HEARTBEAT_TIMEOUT_MS - 1 - h.time.now);
    expect(h.controller.isLapsed()).toBe(false);
    await h.time.advance(1);
    expect(h.controller.isLapsed()).toBe(true);
    expect(h.log.of("LAPSE_STARTED").at(-1)?.atMs).toBe(sentAt + HEARTBEAT_TIMEOUT_MS);
  });

  it("a success that arrives 10 s or more after its send never ends the lapse (late arrival), but advances the id chain", async () => {
    const h = harness({ responseTimeoutMs: 60_000 });
    h.transport.script.push({ defer: true });
    h.controller.start();
    await h.time.advance(0);
    await h.time.advance(HEARTBEAT_TIMEOUT_MS);
    // The next request is answered only when the test says so: the late answer is the only one in view.
    h.transport.script.push({ defer: true });
    h.transport.resolveDeferred({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: "late-id" } });
    await h.time.advance(0);
    expect(h.log.of("LAPSE_ENDED")).toHaveLength(0);
    expect(h.controller.isLapsed()).toBe(true);
    expect(h.log.of("HEARTBEAT_UNCONFIRMED").at(-1)?.reason).toBe("LATE_CONFIRMATION");
    // The id chain advanced: the next request (sent at once: its cadence slot has passed) carries the late id.
    expect(h.transport.requests.map((r) => r.heartbeatId)).toEqual(["", "late-id"]);
  });

  it("a success just under 10 s after its send ends the lapse", async () => {
    const h = harness({ responseTimeoutMs: 60_000 });
    h.transport.script.push({ defer: true });
    h.controller.start();
    await h.time.advance(0);
    await h.time.advance(HEARTBEAT_TIMEOUT_MS - 1);
    h.transport.resolveDeferred({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: "id" } });
    await h.time.advance(0);
    expect(h.log.of("LAPSE_ENDED")).toHaveLength(1);
  });

  it("a success WITHOUT an id (S-D18's {status: ok}) confirms nothing: fails closed", async () => {
    const h = harness();
    h.transport.fallback = () => ({ answer: { kind: "RESPONSE", httpStatus: 200, body: { status: "ok" } } });
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS * 4);
    expect(h.transport.requests.length).toBeGreaterThan(3);
    expect(h.log.of("LAPSE_ENDED")).toHaveLength(0);
    expect(h.controller.isLapsed()).toBe(true);
    expect(h.log.of("HEARTBEAT_UNCONFIRMED").at(-1)?.reason).toBe("SUCCESS_WITHOUT_ID");
  });

  for (const [name, scripted, reason] of [
    ["a transport failure", { answer: { kind: "FAILURE", error: { kind: "TRANSPORT_FAILURE", effect: "UNKNOWN", retryAfterSeconds: null } } }, "TRANSPORT_FAILED"],
    ["a 500", { answer: { kind: "RESPONSE", httpStatus: 500, body: {} } }, "REJECTED"],
    ["a 429", { answer: { kind: "RESPONSE", httpStatus: 429, body: {}, retryAfterSeconds: 1 } }, "RATE_LIMITED"],
    ["a malformed answer", { answer: { heartbeat_id: "raw-body-not-the-contract" } }, "UNKNOWN_OUTCOME"],
    ["a throw", { throws: true }, "UNKNOWN_OUTCOME"],
  ] as const) {
    it(`${name} is unconfirmed (${reason}) and the lapse clock keeps running`, async () => {
      const h = harness();
      h.transport.script.push(ok("id-a"));
      h.transport.fallback = () => scripted;
      await started(h);
      await h.time.advance(HEARTBEAT_TIMEOUT_MS);
      expect(h.log.of("HEARTBEAT_UNCONFIRMED").some((e) => e.reason === reason)).toBe(true);
      expect(h.controller.isLapsed()).toBe(true);
      expect(h.log.of("LAPSE_STARTED").at(-1)?.cause).toBe(reason);
    });
  }

  it("an answer later than the response timeout abandons the call; its late success confirms nothing", async () => {
    const h = harness({ responseTimeoutMs: 2_000 });
    h.transport.script.push({ defer: true });
    h.controller.start();
    await h.time.advance(0);
    await h.time.advance(2_000);
    expect(h.log.of("HEARTBEAT_UNCONFIRMED").at(-1)?.reason).toBe("RESPONSE_TIMEOUT");
    h.transport.resolveDeferred({ kind: "RESPONSE", httpStatus: 200, body: { heartbeat_id: "late" } });
    await h.time.advance(0);
    expect(h.log.of("LAPSE_ENDED")).toHaveLength(0);
  });

  it("one request at a time: no second request while one is in flight", async () => {
    const h = harness({ responseTimeoutMs: 60_000 });
    h.transport.script.push({ defer: true });
    h.controller.start();
    await h.time.advance(HEARTBEAT_CADENCE_MS * 3);
    expect(h.transport.requests).toHaveLength(1);
  });

  it("a monotonic clock that goes backwards is a CLOCK FAULT: the heartbeat is lapsed at once", async () => {
    const h = harness();
    await started(h);
    expect(h.controller.isLapsed()).toBe(false);
    h.time.injectReading(h.time.now - 50_000);
    expect(h.controller.isLapsed()).toBe(true);
    expect(h.log.of("LAPSE_STARTED").at(-1)?.cause).toBe("CLOCK_FAULT");
  });

  it("a WALL-clock step changes nothing about the lapse (ages are monotonic)", async () => {
    const h = harness();
    await started(h);
    h.time.stepWallClock(-3_600_000);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    h.time.stepWallClock(7_200_000);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(h.controller.isLapsed()).toBe(false);
    expect(h.log.of("LAPSE_STARTED")).toHaveLength(1);
  });
});

describe("ADR-033 D3: every heartbeat is filed with WP-310's budget as clob.heartbeat at ORDER_HEARTBEAT", () => {
  it("asks the budget before every send, as the configured operation at rank 1", async () => {
    const h = harness();
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS * 2);
    expect(h.budgetCalls.length).toBe(h.transport.requests.length);
    for (const call of h.budgetCalls) expect(call.input).toEqual({ operationId: HEARTBEAT_OPERATION_ID, priority: HEARTBEAT_PRIORITY });
  });

  it("a refused request is not sent", async () => {
    const refusing: HeartbeatBudget = {
      request: (): RequestDecision => ({ kind: "REFUSED", refusal: { code: "UNKNOWN_OPERATION", message: "no clob.heartbeat in the snapshot" } }),
      withdraw: () => false,
      complete: () => ({ ok: true, value: [] }),
    };
    const h = harness({}, refusing);
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS * 2);
    expect(h.transport.requests).toHaveLength(0);
    expect(h.log.of("HEARTBEAT_UNCONFIRMED")[0]?.reason).toBe("BUDGET_REFUSED");
  });

  it("a queued request is not sent until its grant is routed; a stale ticket is withdrawn at the next tick; the lapse clock keeps running", async () => {
    const withdrawn: string[] = [];
    let tickets = 0;
    const queueing: HeartbeatBudget = {
      request: (): RequestDecision => {
        tickets += 1;
        return { kind: "QUEUED", ticketId: `ticket-${String(tickets)}` };
      },
      withdraw: (ticketId) => {
        withdrawn.push(ticketId);
        return true;
      },
      complete: () => ({ ok: true, value: [] }),
    };
    const h = harness({}, queueing);
    await started(h);
    expect(h.transport.requests).toHaveLength(0);
    expect(withdrawn).toEqual([]);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(withdrawn).toEqual(["ticket-1"]);
    expect(h.transport.requests).toHaveLength(0);
    expect(h.controller.isLapsed()).toBe(true);
    // An event for another ticket is ignored; the current ticket's grant is sent at once.
    h.controller.onBudgetEvents([{ kind: "GRANTED", ticketId: "ticket-1", grant: { grantId: "g-old" } }]);
    expect(h.transport.requests).toHaveLength(0);
    h.controller.onBudgetEvents([{ kind: "GRANTED", ticketId: "ticket-2", grant: { grantId: "g-2" } }]);
    await h.time.advance(0);
    expect(h.transport.requests).toHaveLength(1);
  });

  it("a routed grant is sent only if the gate passes AGAIN; otherwise it is completed unused", async () => {
    const completions: unknown[] = [];
    const queueing: HeartbeatBudget = {
      request: (): RequestDecision => ({ kind: "QUEUED", ticketId: "ticket-q" }),
      withdraw: () => true,
      complete: (_grant, completion) => {
        completions.push(completion.error);
        return { ok: true, value: [] };
      },
    };
    const h = harness({}, queueing);
    await started(h);
    h.gate.answer = { permitted: false, reasons: ["KILL_SWITCH_STOPS_HEARTBEAT"] };
    h.controller.onBudgetEvents([{ kind: "GRANTED", ticketId: "ticket-q", grant: { grantId: "g" } }]);
    await h.time.advance(0);
    expect(h.transport.requests).toHaveLength(0);
    expect(completions).toEqual([{ kind: "NOT_SENT", retryAfterSeconds: null }]);
  });

  it("WP-310 follow_up 3: a queued heartbeat keeps its rank-1 reservation; lower classes waiting on the same IP window are never granted first", async () => {
    // The contract snapshot, with `general` cut to 100 requests per 10 s so the window saturates quickly.
    const document = JSON.parse(JSON.stringify(SNAPSHOT)) as { ipEndpointClasses: { classId: string; windows: { limit: number; windowMs: number }[] }[] };
    const general = document.ipEndpointClasses.find((entry) => entry.classId === "general");
    if (general === undefined) throw new Error("the snapshot has no general class");
    general.windows = [{ limit: 100, windowMs: 10_000 }];
    const budget = budgetFrom(document);
    const h = harness({}, budget);
    const at = h.time.epochMs();
    // Reads take all their 5% headroom allows (95 of 100); emergency cancels (rank 2, no headroom) take the rest.
    for (let index = 0; index < 95; index += 1) expect(budget.request({ operationId: "clob.get_order", priority: "RECONCILIATION_READ" }, at).kind).toBe("GRANTED");
    // A signer's cancel bucket starts empty when first seen (WP-310's cold start); two seconds later it holds its burst.
    const signer = `0x${"c".repeat(40)}`;
    const warm = budget.request({ operationId: "clob.cancel_order", priority: "EMERGENCY_CANCEL", signer }, at);
    expect(warm.kind === "QUEUED" && budget.withdraw(warm.ticketId)).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      expect(budget.request({ operationId: "clob.cancel_order", priority: "EMERGENCY_CANCEL", signer }, at + 2_000).kind).toBe("GRANTED");
    }
    // Lower classes are already waiting when the heartbeat asks.
    const read = budget.request({ operationId: "clob.get_order", priority: "RECONCILIATION_READ" }, at + 2_000);
    const metadata = budget.request({ operationId: "gamma.markets", priority: "METADATA_ANALYTICS" }, at + 2_000);
    expect([read.kind, metadata.kind]).toEqual(["QUEUED", "QUEUED"]);
    h.time.stepWallClock(2_000);
    h.controller.start();
    await h.time.advance(0);
    expect(h.transport.requests).toHaveLength(0);
    expect(h.log.of("HEARTBEAT_UNCONFIRMED").at(-1)?.reason).toBe("BUDGET_QUEUED");
    // The window rolls. The poll grants the heartbeat FIRST (rank 1), and the composition routes the events to it.
    const events = budget.poll(at + 12_000);
    expect(events.map((event) => event.kind)).toEqual(["GRANTED", "GRANTED", "GRANTED"]);
    h.controller.onBudgetEvents(events);
    await h.time.advance(0);
    expect(h.transport.requests).toHaveLength(1);
    const grantedFirst = events[0];
    expect(grantedFirst?.kind === "GRANTED" ? grantedFirst.grant.operationId : null).toBe(HEARTBEAT_OPERATION_ID);
  });

  it("a 429 holds back the heartbeat operation (WP-310: no signer bucket, so only this operation waits)", async () => {
    const budget = budgetFrom(SNAPSHOT);
    const h = harness({}, budget);
    h.transport.script.push({ answer: { kind: "RESPONSE", httpStatus: 429, body: {}, retryAfterSeconds: 30 } });
    await started(h);
    await h.time.advance(HEARTBEAT_CADENCE_MS);
    expect(h.transport.requests).toHaveLength(1);
    expect(h.log.of("HEARTBEAT_UNCONFIRMED").map((e) => e.reason)).toContain("BUDGET_QUEUED");
  });
});

describe("stopping", () => {
  it("stop() sends nothing more, and the lapse that follows is still reported", async () => {
    const h = harness();
    await started(h);
    const sent = h.transport.requests.length;
    h.controller.stop();
    await h.time.advance(HEARTBEAT_TIMEOUT_MS + HEARTBEAT_CADENCE_MS);
    expect(h.transport.requests).toHaveLength(sent);
    expect(h.log.of("LAPSE_STARTED").at(-1)?.cause).toBe("STOPPED");
  });

  it("close() clears every timer", async () => {
    const h = harness();
    await started(h);
    h.controller.close();
    expect(h.time.pendingTimers()).toBe(0);
  });
});
