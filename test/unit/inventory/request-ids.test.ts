/**
 * WP-300c: pins for WP-300b known risk 1, predictable request ids, and for the
 * WP-300c round-1 findings WP300C-J2, WP300C-J6 and WP300C-J7.
 *
 * Request ids were `compositeKey("wallet-op", operationId, "reconciliation",
 * n)`. An answer naming an operation's NEXT request id before that request
 * existed was refused (a request not issued), but once the id was issued the
 * same answer, delivered again, was bound to it and current: it concluded the
 * operation and released its reservation (WP-300b's `nextid-probe`, both
 * routes). The WP-300b round-1 verifier found a variant: an id issued but
 * never delivered (queued while the reconciler was down) was accepted too.
 *
 * The fix (the header's "REQUEST IDS"): an answer is bound only to a request
 * the reconciler has RECEIVED, and every id an answer names before that is
 * recorded and never issued — the next id skips it, and a queued request it
 * names is replaced by a fresh one. Since WP-300c round 1 every id also
 * carries a token the reconciler cannot know in advance
 * (`request-tokens.test.ts`); the pins here name the exact id the manager
 * WILL issue (`RequestTokens.peek`: a reconciler that knows the token source,
 * which the token contract forbids), so they pin the recording rule on its
 * own, as if ids were predictable.
 *
 * WP300C-J2 (HIGH, round 1). `resolveByReconciliation` recorded a named id
 * only after the whole answer had been read. A Proxy whose `requestId`
 * descriptor named the next id, and whose trap on a LATER field
 * (`transactionHash`, `credited`) called back into the manager and issued that
 * very id, was then bound to it and released the reservation. The binding is
 * now settled, and the id recorded, the moment `requestId` is read; and an
 * answer is bound only to a request received BEFORE its read began, so a trap
 * on an EARLIER field (or on `requestId` itself) that issues and delivers a
 * request cannot bind the answer to it either (its `state` predates it).
 *
 * WP300C-J6 (LOW, round 1): an id that was issued but never received (queued)
 * and named by a stale MINED read must be recorded too (mutant V-03 survived).
 * WP300C-J7 (LOW, round 1): the refusal reasons said "not issued" for ids
 * that were issued but never received.
 *
 * Pins marked "(control)" pass on the base (`28d542a`) too. The WP300C-J2 and
 * WP300C-J7 pins (except the controls) fail on the round-0 candidate
 * (`dcad467`) as well.
 *
 * All executors and reconcilers are in-memory mocks. Nothing is signed or sent.
 */

import { describe, expect, it } from "vitest";

import {
  ApprovalTracker,
  WalletOperationManager,
  type ReconciliationRequest,
  type WalletOperationExecutor,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, NO, PUSD, RequestTokens, USDC_E, YES, requestIdOf, seededBook } from "./helpers.js";

const TX_A = "0x" + "a".repeat(64);

const code = (result: { ok: boolean; refusal?: { code: string } }) => (result.ok ? "ok" : result.refusal?.code);

class Reconciler {
  readonly received: ReconciliationRequest[] = [];
  failing = false;
  onRequest: ((request: ReconciliationRequest) => void) | undefined;
  request(request: ReconciliationRequest): void {
    if (this.failing) throw new Error("reconciler unavailable");
    this.received.push(request);
    this.onRequest?.(request);
  }
  ids(operationId = "op"): string[] {
    return this.received.filter((request) => request.walletOperationId === operationId).map((request) => request.requestId);
  }
  latest(operationId = "op"): string {
    const id = this.ids(operationId).at(-1);
    if (id === undefined) throw new Error(`no request for ${operationId}`);
    return id;
  }
}

type Route = "pending" | "in-flight" | "threw" | "not-sent";

function harness(route: Route) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const reconciler = new Reconciler();
  const tokens = new RequestTokens();
  let release: (value: unknown) => void = () => undefined;
  const executor: WalletOperationExecutor = {
    submit: (submission) =>
      submission.operationId !== "op" || route === "threw"
        ? Promise.reject(new Error("socket closed"))
        : route === "in-flight"
          ? Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null })
          : route === "not-sent"
            ? // Unrecognised (NOT_SENT naming a transaction): the operation's own uncertainty, nothing weighed.
              Promise.resolve({ status: "NOT_SENT", transactionHash: TX_A })
            : new Promise<unknown>((resolve) => {
                release = resolve;
              }),
  };
  const manager = new WalletOperationManager({ requestToken: tokens.next, book, approvals: new ApprovalTracker(), executor, reconciler });
  return {
    book,
    reconciler,
    manager,
    tokens,
    release: (): void => release({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }),
    plan: (operationId = "op"): void => {
      expect(manager.plan({ type: "SPLIT", operationId, accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }).ok).toBe(true);
    },
    state: (operationId = "op"): string | undefined => manager.operation(operationId)?.state,
    queued: (operationId = "op"): string[] =>
      manager
        .outstandingReconciliationRequests()
        .filter((request) => request.walletOperationId === operationId)
        .map((request) => request.requestId),
    /** Whether all 100 pUSD can be reserved now: false while "op" holds its 10. */
    wholeReservable: (): boolean => {
      const result = book.reserve({ reservationId: "probe-all", holderRef: "probe-holder", accountRef: ACCOUNT, assetId: PUSD, amount: "100" });
      if (result.ok) book.release({ reservationId: "probe-all" });
      return result.ok;
    },
  };
}

const failed = (requestId: unknown, transactionHash: string | null = TX_A) => ({
  source: "AUTHORITATIVE_READ",
  state: "FAILED",
  transactionHash,
  transactionId: null,
  requestId,
});

describe("predictable request ids: an answer naming an id before the reconciler received it is never bound to it", () => {
  for (const route of ["pending", "in-flight"] as const) {
    it(`${route}: the nextid-probe replay — the answer naming the next id is routed, the id is never issued, and its replay is refused; held`, async () => {
      const h = harness(route);
      h.plan();
      const submitting = h.manager.submit("op");
      if (route === "in-flight") await submitting;
      // The exact id "op"'s first request would carry (the probe's NEXT; the token included).
      const next = requestIdOf("op", 1, h.tokens.peek());
      const first = h.manager.resolveByReconciliation("op", failed(next));
      expect(code(first)).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      if (route === "pending") {
        h.release();
        await submitting;
      }
      // The request raised skips the id the answer named.
      expect(h.reconciler.ids()).toEqual([requestIdOf("op", 2, "k2")]);
      const again = h.manager.resolveByReconciliation("op", failed(next));
      expect(code(again)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.state()).toBe("RECONCILING");
      expect(h.wholeReservable()).toBe(false);
      expect(h.reconciler.ids()).not.toContain(next);
      // Liveness: the answer to the request actually received concludes.
      expect(code(h.manager.resolveByReconciliation("op", failed(h.reconciler.latest())))).toBe("ok");
      expect(h.state()).toBe("FAILED");
      expect(h.wholeReservable()).toBe(true);
    });
  }

  it("ids named ahead of time, before submission, are all skipped; their replays stay unbound", async () => {
    const h = harness("in-flight");
    h.plan();
    const named = [1, 2, 3].map((n) => requestIdOf("op", n, h.tokens.peek(n)));
    for (const id of named) expect(code(h.manager.resolveByReconciliation("op", failed(id)))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    await h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
    expect(h.state()).toBe("RECONCILING");
    expect(h.reconciler.ids()).toEqual([requestIdOf("op", 4, "k4")]);
    for (const id of named) {
      expect(code(h.manager.resolveByReconciliation("op", failed(id))), id).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.state()).toBe("RECONCILING");
    }
    expect(h.wholeReservable()).toBe(false);
    for (const id of named) expect(h.reconciler.ids()).not.toContain(id);
  });

  it("an id named in an answer to an operation that does not exist yet is never issued to it", async () => {
    const h = harness("threw");
    const named = requestIdOf("op", 1, h.tokens.peek());
    expect(code(h.manager.resolveByReconciliation("op", failed(named, null)))).toBe("WALLET_OP_NOT_FOUND");
    h.plan();
    await h.manager.submit("op");
    expect(h.state()).toBe("RECONCILING");
    expect(h.reconciler.ids()).toEqual([requestIdOf("op", 2, "k2")]);
    expect(code(h.manager.resolveByReconciliation("op", failed(named, null)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.state()).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
  });

  it("an id named in an answer addressed to ANOTHER operation is never issued under that id", async () => {
    const h = harness("threw");
    h.plan("op2");
    await h.manager.submit("op2"); // op2's request draws k1
    // op2 weighs the refused answer and raises a request of its own (k2), so "op"'s first request draws k3.
    const named = requestIdOf("op", 1, h.tokens.peek(2));
    expect(code(h.manager.resolveByReconciliation("op2", failed(named, null)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.reconciler.ids("op2")).toHaveLength(2);
    h.plan();
    await h.manager.submit("op");
    expect(h.reconciler.ids()).toEqual([requestIdOf("op", 2, "k4")]);
    expect(code(h.manager.resolveByReconciliation("op", failed(named, null)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.state()).toBe("RECONCILING");
  });

  it("a queued request (the reconciler was down; its delivery threw) is not received: an answer naming it is refused, and it is never delivered under that id", async () => {
    const h = harness("threw");
    h.plan();
    h.reconciler.failing = true;
    await h.manager.submit("op");
    expect(h.state()).toBe("UNKNOWN");
    const queued = h.queued();
    expect(queued).toEqual([requestIdOf("op", 1, "k1")]);
    h.reconciler.failing = false;
    // Delivered before retry (a guess, or a replay): refused, weighed like an observation.
    expect(code(h.manager.resolveByReconciliation("op", failed(queued[0], null)))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(h.manager.retryReconciliationRequests()).toBeGreaterThan(0);
    expect(h.state()).toBe("RECONCILING");
    expect(h.reconciler.ids()).not.toContain(queued[0]);
    // The replay after retry is still unbound: refused, held.
    expect(code(h.manager.resolveByReconciliation("op", failed(queued[0], null)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.state()).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
    // Liveness: an answer to a request the reconciler received concludes.
    expect(code(h.manager.resolveByReconciliation("op", failed(h.reconciler.latest(), null)))).toBe("ok");
    expect(h.state()).toBe("FAILED");
  });

  it("a queued request named while it is still the latest is replaced by a fresh one on retry: same trigger and reason, a new id", async () => {
    const h = harness("threw");
    h.plan();
    h.plan("op2");
    await h.manager.submit("op");
    expect(h.reconciler.ids()).toEqual([requestIdOf("op", 1, "k1")]);
    h.reconciler.failing = true;
    // An observation weighed under reconciliation raises a plain request; the reconciler is down, so it is queued.
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
    const [queued] = h.manager.outstandingReconciliationRequests();
    expect(queued?.requestId).toBe(requestIdOf("op", 2, "k2"));
    // Named (in an answer addressed to another operation) before it was delivered.
    h.manager.resolveByReconciliation("op2", failed(requestIdOf("op", 2, "k2"), null));
    h.reconciler.failing = false;
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    expect(h.reconciler.ids()).toEqual([requestIdOf("op", 1, "k1"), requestIdOf("op", 3, "k3")]);
    const fresh = h.reconciler.received.at(-1);
    expect(fresh).toMatchObject({ trigger: queued?.trigger, reason: queued?.reason, transactionHashes: [TX_A] });
    expect(code(h.manager.resolveByReconciliation("op", failed(requestIdOf("op", 2, "k2"))))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(code(h.manager.resolveByReconciliation("op", failed(requestIdOf("op", 3, "k3"))))).toBe("ok");
    expect(h.state()).toBe("FAILED");
  });

  it("WP300C-J6: a queued id named by a stale MINED read is recorded: retry replaces it, and the replay is never bound (it would put the operation back in flight)", async () => {
    const h = harness("not-sent");
    h.plan();
    h.reconciler.failing = true;
    await h.manager.submit("op");
    expect(h.state()).toBe("UNKNOWN");
    const [queued] = h.queued();
    expect(queued).toBeDefined();
    // A "still in flight" read naming the queued (issued, never received) request: refused, a stale report.
    const read = { source: "AUTHORITATIVE_READ", state: "MINED", transactionHash: TX_A, transactionId: null, requestId: queued };
    expect(code(h.manager.resolveByReconciliation("op", read))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(h.queued()).toEqual([queued]);
    h.reconciler.failing = false;
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    expect(h.state()).toBe("RECONCILING");
    // Never delivered under the id the read named: replaced by a fresh one.
    expect(h.reconciler.ids()).toHaveLength(1);
    expect(h.reconciler.ids()).not.toContain(queued);
    // The replay names a request the reconciler never received: refused, the operation stays under reconciliation.
    expect(code(h.manager.resolveByReconciliation("op", read))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.state()).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
    // Liveness: the read for the request actually received is bound (still in flight).
    expect(code(h.manager.resolveByReconciliation("op", { ...read, requestId: h.reconciler.latest() }))).toBe("ok");
    expect(h.state()).toBe("MINED");
  });

  it("(control) a synchronous requester's answer inside the call is bound to the request being delivered", async () => {
    const h = harness("threw");
    h.plan();
    const inside: string[] = [];
    h.reconciler.onRequest = (request) => {
      h.reconciler.onRequest = undefined;
      inside.push(String(code(h.manager.resolveByReconciliation("op", failed(request.requestId, null)))));
    };
    await h.manager.submit("op");
    expect(inside).toEqual(["ok"]);
    expect(h.state()).toBe("FAILED");
  });

  it("(control) an answer to a request the reconciler received is bound to it, and a later request's id is not skipped", async () => {
    const h = harness("in-flight");
    h.plan();
    await h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
    expect(h.reconciler.ids()).toEqual([requestIdOf("op", 1, "k1")]);
    expect(code(h.manager.resolveByReconciliation("op", failed(requestIdOf("op", 1, "k1"))))).toBe("ok");
    expect(h.state()).toBe("FAILED");
  });
});

// ------------------------------------------------------------- WP300C-J2 --

/**
 * An answer as a Proxy reporting `raw`'s fields: the FIRST read of `field`'s
 * descriptor calls `act` (back into the manager) before the descriptor is
 * reported; `requestId` reports `requestId()`, evaluated when it is read. It
 * records whether the request it named had been received when it was named.
 */
function reentrant(
  raw: Readonly<Record<string, unknown>>,
  field: string,
  act: () => void,
  requestId: () => string,
  received: () => readonly string[],
) {
  let fired = false;
  let receivedWhenNamed: boolean | undefined;
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(_target, key) {
        if (key === field && !fired) {
          fired = true;
          act();
        }
        if (key === "requestId") {
          const value = requestId();
          receivedWhenNamed = received().includes(value);
          return { value, writable: true, enumerable: true, configurable: true };
        }
        if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(raw, key)) return undefined;
        return { value: raw[key], writable: true, enumerable: true, configurable: true };
      },
      has: () => false,
    },
  );
  return { proxy, fired: (): boolean => fired, receivedWhenNamed: (): boolean | undefined => receivedWhenNamed };
}

describe("WP300C-J2: an answer is never bound to a request issued during its own read (the binding is settled when requestId is read, against what was received before the read began)", () => {
  const FAILED_A = { source: "AUTHORITATIVE_READ", state: "FAILED", transactionHash: TX_A, transactionId: null };

  for (const field of ["transactionHash", "credited"] as const) {
    it(`RECONCILING: requestId names the next id, then a ${field} trap observes CONFIRMED(A), which issues a request — the answer stays unbound; held`, async () => {
      const h = harness("in-flight");
      h.plan();
      await h.manager.submit("op");
      h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
      expect(h.state()).toBe("RECONCILING");
      const request1 = h.reconciler.latest();
      // The exact id the next request would carry (ordinal 2, the next token).
      const named = requestIdOf("op", 2, h.tokens.peek());
      const answer = reentrant(
        FAILED_A,
        field,
        () => void h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null }),
        () => named,
        () => h.reconciler.ids(),
      );
      const result = h.manager.resolveByReconciliation("op", answer.proxy);
      expect(answer.fired()).toBe(true);
      expect(answer.receivedWhenNamed()).toBe(false);
      expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.state()).toBe("RECONCILING");
      expect(h.wholeReservable()).toBe(false);
      // The trap's request skipped the named id.
      expect(h.reconciler.ids()[0]).toBe(request1);
      expect(h.reconciler.ids()).not.toContain(named);
      // Liveness: an answer for the request the reconciler received concludes.
      expect(code(h.manager.resolveByReconciliation("op", failed(h.reconciler.latest())))).toBe("ok");
      expect(h.state()).toBe("FAILED");
    });
  }

  it("in flight (the nextid-probe inside one call): requestId names the first id, then a transactionHash trap observes DROPPED(A), which issues it — unbound; held", async () => {
    const h = harness("in-flight");
    h.plan();
    await h.manager.submit("op");
    expect(h.state()).toBe("SUBMITTED");
    expect(h.reconciler.ids()).toEqual([]);
    const named = requestIdOf("op", 1, h.tokens.peek());
    const answer = reentrant(
      FAILED_A,
      "transactionHash",
      () => void h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A }),
      () => named,
      () => h.reconciler.ids(),
    );
    const result = h.manager.resolveByReconciliation("op", answer.proxy);
    expect(answer.fired()).toBe(true);
    expect(answer.receivedWhenNamed()).toBe(false);
    expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.state()).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
    expect(h.reconciler.ids()).not.toContain(named);
  });

  it("UNKNOWN with the request queued: requestId names it, then a transactionHash trap brings the reconciler up and retries — it is never delivered under that id; unbound; held", async () => {
    const h = harness("threw");
    h.plan();
    h.reconciler.failing = true;
    await h.manager.submit("op");
    expect(h.state()).toBe("UNKNOWN");
    const [queued] = h.queued();
    if (queued === undefined) throw new Error("no queued request");
    const answer = reentrant(
      FAILED_A,
      "transactionHash",
      () => {
        h.reconciler.failing = false;
        h.manager.retryReconciliationRequests();
      },
      () => queued,
      () => h.reconciler.ids(),
    );
    const result = h.manager.resolveByReconciliation("op", answer.proxy);
    expect(answer.fired()).toBe(true);
    expect(answer.receivedWhenNamed()).toBe(false);
    expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.state()).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
    expect(h.reconciler.ids()).not.toContain(queued);
  });

  // A request received DURING the answer's own read is not bound either: a field read before it predates it.
  for (const field of ["state", "requestId"] as const) {
    it(`a trap on ${field} (read before requestId names anything) observes CONFIRMED(A), which issues and delivers request 2; a requestId naming request 2 is NOT bound — the state was read before it existed; held`, async () => {
      const h = harness("in-flight");
      h.plan();
      await h.manager.submit("op");
      h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
      let named = "";
      const answer = reentrant(
        FAILED_A,
        field,
        () => void h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null }),
        () => (named = h.reconciler.latest()),
        () => h.reconciler.ids(),
      );
      const result = h.manager.resolveByReconciliation("op", answer.proxy);
      expect(answer.fired()).toBe(true);
      // Request 2 had been received by the time it was named, but not when the read began.
      expect(answer.receivedWhenNamed()).toBe(true);
      expect(h.reconciler.ids()[1]).toBe(named);
      expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.state()).toBe("RECONCILING");
      expect(h.wholeReservable()).toBe(false);
      // Liveness: the same FAILED(A), read afresh for the latest request, concludes.
      expect(code(h.manager.resolveByReconciliation("op", failed(h.reconciler.latest())))).toBe("ok");
      expect(h.state()).toBe("FAILED");
    });
  }

  it("(control) a trap that calls back into the manager without delivering a request leaves the binding as it was: FAILED(A) for the request received before the read concludes", async () => {
    const h = harness("in-flight");
    h.plan();
    await h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
    const request1 = h.reconciler.latest();
    const answer = reentrant(
      FAILED_A,
      "transactionHash",
      () => {
        h.manager.retryReconciliationRequests(); // nothing is queued: nothing is delivered
        expect(h.manager.operation("op")?.state).toBe("RECONCILING");
      },
      () => request1,
      () => h.reconciler.ids(),
    );
    const result = h.manager.resolveByReconciliation("op", answer.proxy);
    expect(answer.fired()).toBe(true);
    expect(answer.receivedWhenNamed()).toBe(true);
    expect(code(result)).toBe("ok");
    expect(h.state()).toBe("FAILED");
  });
});

// ------------------------------------------------------------- WP300C-J7 --

describe("WP300C-J7: a request issued but never received is refused as 'never received', not 'not issued'", () => {
  it("under reconciliation: a FAILED(A) naming the operation's queued request is refused, and the reason says the reconciler never received it", async () => {
    const h = harness("in-flight");
    h.plan();
    await h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
    h.reconciler.failing = true;
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    const [queued] = h.queued();
    expect(queued).toBeDefined();
    const result = h.manager.resolveByReconciliation("op", failed(queued));
    expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    if (result.ok) throw new Error("accepted");
    expect(result.refusal.message).toContain("never received");
    expect(result.refusal.message).not.toContain("not issued");
    expect(result.refusal.details["requestId"]).toBe(queued);
  });

  it("in flight: a FAILED(A) naming an id never received is refused SUPERSEDED, and what supersedes it says the reconciler never received it", async () => {
    const h = harness("in-flight");
    h.plan();
    await h.manager.submit("op");
    const result = h.manager.resolveByReconciliation("op", failed(requestIdOf("op", 1, h.tokens.peek())));
    expect(code(result)).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    if (result.ok) throw new Error("accepted");
    expect(String(result.refusal.details["supersededBy"])).toContain("never received");
    expect(String(result.refusal.details["supersededBy"])).not.toContain("not issued");
  });
});
