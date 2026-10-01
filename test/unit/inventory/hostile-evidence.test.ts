/**
 * WP-300c: pins for WP300B-R1-01 and WP300B-R1-02 (LOW), found by the WP-300b
 * round-1 verifiers.
 *
 * WP300B-R1-01. `resolveByReconciliation` read the answer's `state` twice:
 * once to decide (MINED: not terminal, so not routed), and again to handle the
 * refused answer like an observation (FAILED: applied in flight, or kept while
 * PLANNED and applied after the executor's SUBMITTED). A Proxy whose
 * `getOwnPropertyDescriptor` trap said MINED, then FAILED, concluded the
 * operation and released its reservation. The identity fields were read twice
 * too, and the executor's answer and observations named one identity to the
 * classifier and another to the identity set.
 *
 * WP300B-R1-02. A `requestId` that was a getter or inherited read as "names no
 * request", which is current: a FAILED bound (by such a field) to another
 * operation's request was kept while PLANNED and concluded after SUBMITTED, or
 * concluded in flight. An identity field that was a getter or inherited read
 * as "names nothing", so a FAILED naming an unreadable hash concluded an
 * operation that had named none, the hash never joining the identity set.
 *
 * The fix reads every field ONCE, at the door, and decides on that snapshot; a
 * field that is present but not own data is OPAQUE and makes the evidence
 * unrecognised. Pins marked "(control)" pass on the base too; every other pin
 * fails on the base (`28d542a`).
 *
 * All executors and reconcilers are in-memory mocks. Nothing is signed or sent.
 */

import { describe, expect, it } from "vitest";

import {
  ApprovalTracker,
  WalletOperationManager,
  type ReconciliationRequest,
  type WalletOperationExecutor,
  type WalletOperationView,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, NO, PUSD, USDC_E, YES, seededBook } from "./helpers.js";

const TX_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_R = "sanitized-relayer-id-r";

const code = (result: { ok: boolean; refusal?: { code: string } }) => (result.ok ? "ok" : result.refusal?.code);

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  failing = false;
  request(request: ReconciliationRequest): void {
    if (this.failing) throw new Error("reconciler unavailable");
    this.requests.push(request);
  }
  for(operationId: string): string[] {
    return this.requests.filter((request) => request.walletOperationId === operationId).map((request) => request.requestId);
  }
  latest(operationId = "op"): string {
    const id = this.for(operationId).at(-1);
    if (id === undefined) throw new Error(`no request for ${operationId}`);
    return id;
  }
}

type Route = "pending" | "in-flight" | "threw";

/**
 * "op" (a SPLIT of 10 pUSD) waits on a pending executor call, is in flight
 * after SUBMITTED(A), or is RECONCILING after the executor threw (simple mode,
 * nothing named). "op2", a WRAP on USDC.e, answers "???", so it goes UNKNOWN and
 * gets a REAL reconciliation request: a request issued for ANOTHER operation.
 */
async function harness(route: Route, executorAnswer: unknown = { status: "SUBMITTED", transactionHash: TX_A, transactionId: null }) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const reconciler = new Reconciler();
  let release: (value: unknown) => void = () => undefined;
  const executor: WalletOperationExecutor = {
    submit: (submission) =>
      submission.operationId === "op2"
        ? Promise.resolve({ status: "???" })
        : route === "in-flight"
          ? Promise.resolve(executorAnswer)
          : route === "threw"
            ? Promise.reject(new Error("socket closed"))
            : new Promise<unknown>((resolve) => {
                release = resolve;
              }),
  };
  const manager = new WalletOperationManager({ book, approvals: new ApprovalTracker(), executor, reconciler });
  expect(manager.plan({ type: "WRAP_COLLATERAL", operationId: "op2", accountRef: ACCOUNT, amount: "10" }).ok).toBe(true);
  await manager.submit("op2");
  const r2 = reconciler.latest("op2");
  expect(manager.plan({ type: "SPLIT", operationId: "op", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }).ok).toBe(true);
  const submitting = manager.submit("op");
  if (route !== "pending") await submitting;
  return {
    book,
    reconciler,
    manager,
    r2,
    /** The executor answers (pending route) and the call completes. */
    settle: async (): Promise<void> => {
      release(executorAnswer);
      await submitting;
    },
    view: (): WalletOperationView => {
      const view = manager.operation("op");
      if (view === undefined) throw new Error("op missing");
      return view;
    },
    /** Whether all 100 pUSD can be reserved now: false while "op" holds its 10. */
    wholeReservable: (): boolean => {
      const result = book.reserve({ reservationId: "probe-all", holderRef: "probe-holder", accountRef: ACCOUNT, assetId: PUSD, amount: "100" });
      if (result.ok) book.release({ reservationId: "probe-all" });
      return result.ok;
    },
  };
}

/** A data descriptor, as a Proxy trap must report one for an extensible, empty target. */
const data = (value: unknown): PropertyDescriptor => ({ value, writable: true, enumerable: true, configurable: true });

/**
 * A Proxy whose `getOwnPropertyDescriptor` trap reports, for each key, the
 * next descriptor of its sequence on every read (the last one repeats), and
 * counts every trap call. A key without a sequence is absent.
 */
function changing(sequences: Readonly<Record<string, readonly (PropertyDescriptor | undefined)[]>>) {
  const reads: Record<string, number> = {};
  const has: Record<string, number> = {};
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(_target, key) {
        if (typeof key !== "string") return undefined;
        reads[key] = (reads[key] ?? 0) + 1;
        const sequence = sequences[key];
        if (sequence === undefined) return undefined;
        return sequence[Math.min(reads[key] - 1, sequence.length - 1)];
      },
      has(_target, key) {
        if (typeof key === "string") has[key] = (has[key] ?? 0) + 1;
        return false;
      },
    },
  );
  return { proxy, reads, has };
}

/** The getter calls an evidence object received (its getters must never run). */
function withGetter(base: Record<string, unknown>, key: string, value: unknown): { evidence: object; calls: () => number } {
  let calls = 0;
  const evidence = { ...base };
  Object.defineProperty(evidence, key, {
    get: () => {
      calls += 1;
      return value;
    },
    enumerable: true,
    configurable: true,
  });
  return { evidence, calls: () => calls };
}

function inherited(base: Record<string, unknown>, key: string, value: unknown): object {
  return Object.assign(Object.create({ [key]: value }) as object, base);
}

const answer = (fields: Readonly<Record<string, unknown>>) => ({ source: "AUTHORITATIVE_READ", transactionId: null, ...fields });

// -------------------------------------------------------- WP300B-R1-01 --

describe("WP300B-R1-01: the answer is read once, at the door, and decided on that snapshot", () => {
  for (const route of ["pending", "in-flight"] as const) {
    it(`${route}: a Proxy whose state reads MINED, then FAILED (bound to op2's real request) never concludes; each field is read once`, async () => {
      const h = await harness(route);
      const hostile = changing({
        source: [data("AUTHORITATIVE_READ")],
        state: [data("MINED"), data("FAILED")],
        transactionHash: [data(TX_A)],
        transactionId: [data(null)],
        requestId: [data(h.r2)],
      });
      expect(code(h.manager.resolveByReconciliation("op", hostile.proxy))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
      if (route === "pending") {
        // Decided as MINED (not terminal): kept like the same observation.
        expect(h.view()).toMatchObject({ state: "PLANNED", bufferedObservations: 1 });
        await h.settle();
      }
      // The snapshot said MINED: it is applied as MINED, never as FAILED.
      expect(h.view().state).toBe("MINED");
      expect(h.wholeReservable()).toBe(false);
      expect(h.book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
      for (const key of ["source", "state", "requestId", "transactionHash", "transactionId", "credited"]) {
        expect(hostile.reads[key] ?? 0, key).toBe(1);
      }
    });

    it(`${route}: the getter variant — state an accessor on the first read, FAILED data afterwards — is unrecognised, held, and the getter never runs`, async () => {
      const h = await harness(route);
      let getterCalls = 0;
      const getter: PropertyDescriptor = {
        get: () => {
          getterCalls += 1;
          return "FAILED";
        },
        enumerable: true,
        configurable: true,
      };
      const hostile = changing({
        source: [data("AUTHORITATIVE_READ")],
        state: [getter, data("FAILED")],
        transactionHash: [data(TX_A)],
        transactionId: [data(null)],
        requestId: [data(h.r2)],
      });
      expect(code(h.manager.resolveByReconciliation("op", hostile.proxy))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
      // Unrecognised: the operation goes to reconciliation at once (never kept, never applied).
      expect(h.view()).toMatchObject({ state: "RECONCILING", bufferedObservations: 0 });
      if (route === "pending") await h.settle();
      expect(h.view().state).toBe("RECONCILING");
      expect(h.wholeReservable()).toBe(false);
      expect(getterCalls).toBe(0);
      expect(hostile.reads["state"]).toBe(1);
      // Liveness: a current answer naming A concludes and releases.
      expect(code(h.manager.resolveByReconciliation("op", answer({ state: "FAILED", transactionHash: TX_A, requestId: h.reconciler.latest() })))).toBe("ok");
      expect(h.view().state).toBe("FAILED");
      expect(h.wholeReservable()).toBe(true);
    });
  }

  it("(control) a plain getter state is never run and reads as unrecognised: in flight, the operation goes to reconciliation", async () => {
    const h = await harness("in-flight");
    const { evidence, calls } = withGetter(answer({ transactionHash: TX_A, requestId: h.r2 }), "state", "FAILED");
    expect(code(h.manager.resolveByReconciliation("op", evidence))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(h.view().state).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
    expect(calls()).toBe(0);
  });

  it("an answer whose transactionId read throws is unrecognised: the call never throws, and the reservation stays held", async () => {
    for (const route of ["pending", "in-flight", "threw"] as const) {
      const h = await harness(route);
      const hostile = new Proxy(
        { source: "AUTHORITATIVE_READ", state: "FAILED", transactionHash: TX_A, transactionId: null },
        {
          getOwnPropertyDescriptor(target, key) {
            if (key === "transactionId") throw new Error("hostile trap");
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      expect(code(h.manager.resolveByReconciliation("op", hostile)), route).toBe(route === "threw" ? "WALLET_OP_EVIDENCE_REQUIRED" : "WALLET_OP_ILLEGAL_TRANSITION");
      if (route === "pending") await h.settle();
      expect(h.view().state, route).toBe("RECONCILING");
      expect(h.wholeReservable(), route).toBe(false);
    }
  });

  it("a revoked Proxy is unrecognised, never a crash: nothing concludes", async () => {
    const h = await harness("threw");
    const { proxy, revoke } = Proxy.revocable({ source: "AUTHORITATIVE_READ", state: "FAILED" }, {});
    revoke();
    expect(code(h.manager.resolveByReconciliation("op", proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.view().state).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
  });

  it("(control) a trap that calls back into the manager acts before the call it belongs to (the snapshot is taken first)", async () => {
    const h = await harness("in-flight");
    // Inside the snapshot, the trap delivers an observation that sends the operation to reconciliation.
    let reentered = false;
    const hostile = new Proxy(answer({ state: "FAILED", transactionHash: TX_A, requestId: h.r2 }), {
      getOwnPropertyDescriptor(target, key) {
        if (!reentered) {
          reentered = true;
          h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    // The outer answer is decided after the re-entrant call: the operation is RECONCILING and op2's request is not its own.
    expect(code(h.manager.resolveByReconciliation("op", hostile))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.view().state).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
  });

  it("the executor's answer is read once: a Proxy naming A to the classifier and B afterwards teaches the operation A only", async () => {
    const hostile = changing({ status: [data("SUBMITTED")], transactionHash: [data(TX_A), data(TX_B)], transactionId: [data(null)] });
    const h = await harness("in-flight", hostile.proxy);
    expect(h.view()).toMatchObject({ state: "SUBMITTED", transactionHashes: [TX_A], transactionIds: [] });
    expect(hostile.reads["transactionHash"]).toBe(1);
    expect(hostile.reads["status"]).toBe(1);
  });

  it("an observation is read once: a Proxy naming an unknown hash first, A afterwards, is decided on what it said first", async () => {
    const h = await harness("in-flight");
    const hostile = changing({ status: [data("FAILED")], transactionHash: [data(TX_B), data(TX_A)], transactionId: [data(null)] });
    // As read first: FAILED under another hash than the operation's A — conflicting evidence, never a conclusion.
    expect(code(h.manager.observe("op", hostile.proxy))).toBe("ok");
    expect(h.view()).toMatchObject({ state: "RECONCILING", transactionHashes: [TX_A, TX_B] });
    expect(h.wholeReservable()).toBe(false);
    expect(hostile.reads["transactionHash"]).toBe(1);
    expect(hostile.reads["status"]).toBe(1);
  });
});

/**
 * Differential pin: for Proxies that answer every read differently, the
 * manager decides exactly as it does for a plain object holding what each
 * field said FIRST — same code, same view, same requests, same book.
 */
describe("WP300B-R1-01: a Proxy that changes on every read is decided as the plain object of its first reads", () => {
  const STATES = ["MINED", "FAILED", "CONFIRMED", "SUBMITTED", "NOT_FOUND"] as const;
  const HASHES = [TX_A, TX_B, null] as const;
  type Binding = "none" | "r2" | "latest" | "null";

  async function outcome(route: Route, first: Readonly<Record<string, unknown>>, later: Readonly<Record<string, unknown>>, viaProxy: boolean) {
    const h = await harness(route);
    const bind = (binding: unknown): unknown =>
      binding === "r2" ? h.r2 : binding === "latest" ? (h.reconciler.for("op").at(-1) ?? null) : binding === "null" ? null : undefined;
    const firstFields: Record<string, unknown> = {};
    const laterFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(first)) firstFields[key] = key === "requestId" ? bind(value) : value;
    for (const [key, value] of Object.entries(later)) laterFields[key] = key === "requestId" ? bind(value) : value;
    for (const key of Object.keys(firstFields)) if (firstFields[key] === undefined) delete firstFields[key];
    let evidence: object = firstFields;
    let reads: Record<string, number> = {};
    if (viaProxy) {
      const sequences: Record<string, (PropertyDescriptor | undefined)[]> = {};
      for (const key of ["source", "state", "requestId", "transactionHash", "transactionId", "credited"]) {
        const a = key in firstFields ? data(firstFields[key]) : undefined;
        const b = laterFields[key] === undefined ? undefined : data(laterFields[key]);
        sequences[key] = [a, b];
      }
      const hostile = changing(sequences);
      evidence = hostile.proxy;
      reads = hostile.reads;
    }
    const result = code(h.manager.resolveByReconciliation("op", evidence));
    if (route === "pending") await h.settle();
    const view = h.view();
    return {
      result,
      reads,
      snapshot: {
        state: view.state,
        bufferedObservations: view.bufferedObservations,
        transactionHashes: view.transactionHashes,
        transactionIds: view.transactionIds,
        unresolved: view.unresolvedTransactions,
        requests: h.reconciler.for("op"),
        reserved: h.book.line(ACCOUNT, PUSD)?.reserved,
        actual: [h.book.line(ACCOUNT, PUSD)?.actual, h.book.line(ACCOUNT, YES)?.actual],
        events: h.manager.events("op").map((event) => event.newState),
      },
    };
  }

  for (const route of ["pending", "in-flight", "threw"] as const) {
    it(`${route}: every combination of first and later reads`, async () => {
      let compared = 0;
      for (const state of STATES) {
        for (const laterState of ["FAILED", "CONFIRMED", "MINED"] as const) {
          if (laterState === state) continue;
          for (const hash of HASHES) {
            for (const binding of ["none", "r2", "latest", "null"] as const satisfies readonly Binding[]) {
              const first = { source: "AUTHORITATIVE_READ", state, transactionHash: hash, transactionId: null, requestId: binding };
              const later = { source: "AUTHORITATIVE_READ", state: laterState, transactionHash: TX_A, transactionId: ID_R, requestId: binding === "none" ? "latest" : "none", credited: "1" };
              const label = `${route} ${state}→${laterState} hash ${String(hash)} bound ${binding}`;
              const plain = await outcome(route, first, later, false);
              const hostile = await outcome(route, first, later, true);
              expect(hostile.result, label).toBe(plain.result);
              expect(hostile.snapshot, label).toEqual(plain.snapshot);
              for (const [key, count] of Object.entries(hostile.reads)) expect(count, `${label}: reads of ${key}`).toBe(1);
              compared += 1;
            }
          }
        }
      }
      expect(compared).toBe(STATES.length * 3 * HASHES.length * 4 - 3 * HASHES.length * 4);
    });
  }
});

// -------------------------------------------------------- WP300B-R1-02 --

describe("WP300B-R1-02: a requestId that is present but not own data is unrecognised, never current", () => {
  const forms = {
    getter: (r2: string) => withGetter(answer({ state: "FAILED", transactionHash: TX_A }), "requestId", r2),
    inherited: (r2: string) => ({ evidence: inherited(answer({ state: "FAILED", transactionHash: TX_A }), "requestId", r2), calls: () => 0 }),
  } as const;

  for (const [form, make] of Object.entries(forms)) {
    it(`PLANNED, executor pending: an AUTHORITATIVE FAILED(A) whose requestId is ${form} (op2's request) is never kept; held after SUBMITTED`, async () => {
      const h = await harness("pending");
      const { evidence, calls } = make(h.r2);
      expect(code(h.manager.resolveByReconciliation("op", evidence))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
      expect(h.view()).toMatchObject({ state: "RECONCILING", bufferedObservations: 0, transactionHashes: [TX_A] });
      await h.settle();
      expect(h.view()).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_A}`], effectsApplied: false });
      expect(h.wholeReservable()).toBe(false);
      expect(calls()).toBe(0);
      // Liveness: a current answer naming A, by name, concludes.
      expect(code(h.manager.resolveByReconciliation("op", answer({ state: "FAILED", transactionHash: TX_A, requestId: h.reconciler.latest() })))).toBe("ok");
      expect(h.view().state).toBe("FAILED");
      expect(h.wholeReservable()).toBe(true);
    });

    it(`in flight: an AUTHORITATIVE FAILED(A) whose requestId is ${form} is never applied; the reservation stays held`, async () => {
      const h = await harness("in-flight");
      const { evidence, calls } = make(h.r2);
      expect(code(h.manager.resolveByReconciliation("op", evidence))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
      expect(h.view()).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_A}`] });
      expect(h.wholeReservable()).toBe(false);
      expect(calls()).toBe(0);
    });

    it(`under reconciliation: an AUTHORITATIVE FAILED whose requestId is ${form} is refused and weighed, never accepted as current`, async () => {
      const h = await harness("threw");
      const make2 = form === "getter" ? withGetter(answer({ state: "FAILED" }), "requestId", h.r2) : { evidence: inherited(answer({ state: "FAILED" }), "requestId", h.r2), calls: () => 0 };
      expect(code(h.manager.resolveByReconciliation("op", make2.evidence))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.view().state).toBe("RECONCILING");
      expect(h.wholeReservable()).toBe(false);
    });
  }

  for (const field of ["transactionHash", "transactionId"] as const) {
    const value = field === "transactionHash" ? TX_A : ID_R;
    for (const form of ["getter", "inherited"] as const) {
      it(`the same rule for every identity field: a FAILED whose ${field} is ${form} never reads as "names nothing" (it would conclude an operation that named none)`, async () => {
        const h = await harness("threw");
        const base = answer({ state: "FAILED", requestId: h.reconciler.latest() });
        if (field === "transactionId") delete (base as Record<string, unknown>)["transactionId"];
        const evidence = form === "getter" ? withGetter(base, field, value).evidence : inherited(base, field, value);
        expect(code(h.manager.resolveByReconciliation("op", evidence))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
        expect(h.view().state).toBe("RECONCILING");
        expect(h.wholeReservable()).toBe(false);
        // Weighed as unrecognised: every member must now be answered by name, and a plain FAILED naming nothing still concludes.
        expect(code(h.manager.resolveByReconciliation("op", answer({ state: "FAILED", requestId: h.reconciler.latest() })))).toBe("ok");
        expect(h.view().state).toBe("FAILED");
      });
    }
  }

  it("a CONFIRMED whose credited amount is a getter is unrecognised: a WRAP never concludes on an amount it cannot read", async () => {
    const book = seededBook({ [PUSD]: "100", [USDC_E]: "50" });
    const reconciler = new Reconciler();
    const manager = new WalletOperationManager({
      book,
      approvals: new ApprovalTracker(),
      reconciler,
      executor: { submit: () => Promise.reject(new Error("socket closed")) },
    });
    expect(manager.plan({ type: "WRAP_COLLATERAL", operationId: "op", accountRef: ACCOUNT, amount: "10" }).ok).toBe(true);
    await manager.submit("op");
    const { evidence, calls } = withGetter(answer({ state: "CONFIRMED", transactionHash: TX_A, requestId: reconciler.latest() }), "credited", "10");
    expect(code(manager.resolveByReconciliation("op", evidence))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(manager.operation("op")?.state).toBe("RECONCILING");
    expect(book.line(ACCOUNT, USDC_E)?.reserved).toBe("10");
    expect(calls()).toBe(0);
  });

  it("an observation whose transactionHash is inherited is unrecognised: in flight it never concludes FAILED", async () => {
    const h = await harness("in-flight");
    const observation = inherited({ status: "FAILED", transactionId: null }, "transactionHash", TX_A);
    expect(code(h.manager.observe("op", observation))).toBe("ok");
    expect(h.view().state).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
  });

  it("(control) an executor answer whose transactionHash is inherited is unrecognised (it already was)", async () => {
    const h = await harness("in-flight", inherited({ status: "SUBMITTED", transactionId: null }, "transactionHash", TX_A));
    expect(h.view()).toMatchObject({ state: "RECONCILING", transactionHashes: [] });
  });

  it("(control) frozen and sealed answers are own data: read like plain ones", async () => {
    for (const seal of [(o: object): object => Object.freeze(o), (o: object): object => Object.seal(o)]) {
      const h = await harness("threw");
      const evidence = seal(answer({ state: "FAILED", requestId: h.reconciler.latest() }));
      expect(code(h.manager.resolveByReconciliation("op", evidence))).toBe("ok");
      expect(h.view().state).toBe("FAILED");
    }
  });

  it("(control) requestId values that are not strings name a request never issued: a number, an object, a symbol, an empty string", async () => {
    for (const requestId of [7, { id: "x" }, Symbol("r"), ""]) {
      const h = await harness("in-flight");
      expect(code(h.manager.resolveByReconciliation("op", answer({ state: "FAILED", transactionHash: TX_A, requestId }))), String(requestId)).toBe(
        "WALLET_OP_EVIDENCE_SUPERSEDED",
      );
      expect(h.view().state).toBe("RECONCILING");
      expect(h.wholeReservable()).toBe(false);
      expect(code(h.manager.resolveByReconciliation("op", answer({ state: "FAILED", transactionHash: TX_A, requestId })))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    }
  });

  it("(control) an own requestId of undefined or null names no request (the request contract is unchanged)", async () => {
    for (const requestId of [undefined, null]) {
      const h = await harness("threw");
      expect(code(h.manager.resolveByReconciliation("op", answer({ state: "FAILED", requestId })))).toBe("ok");
      expect(h.view().state).toBe("FAILED");
    }
  });
});
