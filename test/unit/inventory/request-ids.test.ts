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
 * WP300C-R2-X1 (LOW, round 2): the refusal of an answer naming a request
 * received only DURING its own read did not persist. A Proxy whose trap on
 * `source`, `state` or `requestId` observed DROPPED(A) (which issued and
 * delivered request 2) and then named request 2 was refused, but a frozen
 * plain replay of the same values naming request 2 then concluded the
 * operation: the SPLIT released, both approvals ready after a sync. Such an
 * id is now recorded and never bound; if it is the operation's latest
 * request, a fresh request replaces it (owed while the executor call is
 * pending), so the reconciler always holds a request it can answer. The same
 * stale values relabelled with that fresh request still bind: that is the
 * relabelled stale read no id can show (WP-290), pinned as a control.
 * WP300C-R2-X2 (LOW, round 2): that first refusal said the reconciler "never
 * received" the request, although it was received during the answer's read.
 *
 * WP300C-R3-01 (LOW, round 3): no pin covered the replacement request when it
 * cannot be delivered at once. The code queues it (`#deliverOrQueue`), but a
 * mutant that only tried to deliver it (O-2) survived the whole suite: with
 * the reconciler down it stranded the operation in RECONCILING (nothing
 * queued, retry delivering nothing, an honest answer refused); raised inside
 * another operation's delivery, it delivered re-entrantly. Pinned: the
 * replacement is queued when the reconciler is down, when its token draw
 * fails, and when it is raised inside another operation's delivery; it is
 * never delivered re-entrantly, and retry delivers it (after a failed draw, a
 * fresh request in its place).
 * WP300C-R3-02 (INFO, round 3): no negative pin covered where the replacement
 * fires (mutants O-7 and O-8 survived). Pinned: none fires when the recorded
 * id is the latest of an operation that is terminal and not quarantined, or
 * back in flight. These are test-only pins: they pass on `168760f` (the code
 * was right) and fail on O-2, O-7 and O-8.
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
  WALLET_OPERATION_UNKNOWN_TRIGGER,
  WalletOperationManager,
  type ReconciliationRequest,
  type WalletOperationExecutor,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, CTF_EXCHANGE, NO, PUSD, RequestTokens, USDC_E, YES, requestIdOf, seededBook } from "./helpers.js";

const TX_A = "0x" + "a".repeat(64);

const code = (result: { ok: boolean; refusal?: { code: string } }) => (result.ok ? "ok" : result.refusal?.code);

class Reconciler {
  readonly received: ReconciliationRequest[] = [];
  failing = false;
  onRequest: ((request: ReconciliationRequest) => void) | undefined;
  /** How many `request` calls are in progress now, and the most ever at once (WP300C-R3-01: never above 1). */
  depth = 0;
  maxDepth = 0;
  request(request: ReconciliationRequest): void {
    if (this.failing) throw new Error("reconciler unavailable");
    this.received.push(request);
    this.depth += 1;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
    try {
      this.onRequest?.(request);
    } finally {
      this.depth -= 1;
    }
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

// ---------------------------------------------------------- WP300C-R2-X1 --

type Kind = "SPLIT" | "APPROVE_ERC20" | "APPROVE_ERC1155";

/**
 * WP300C-R2-X1: a SPLIT or an approval in flight (SUBMITTED(A)), plus what
 * shows whether its reservation was released (SPLIT) or the approval is ready
 * after a CLOB allowance sync. `requestToken` replaces the default counter
 * source (WP300C-R3-01: one whose draws can be made to fail).
 */
async function inFlight(kind: Kind, requestToken?: () => string) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const approvals = new ApprovalTracker();
  const reconciler = new Reconciler();
  const tokens = new RequestTokens();
  const executor: WalletOperationExecutor = {
    submit: () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }),
  };
  const manager = new WalletOperationManager({ requestToken: requestToken ?? tokens.next, book, approvals, executor, reconciler });
  const plan =
    kind === "SPLIT"
      ? { type: kind, operationId: "op", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }
      : kind === "APPROVE_ERC20"
        ? { type: kind, operationId: "op", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" }
        : { type: kind, operationId: "op", accountRef: ACCOUNT, spender: CTF_EXCHANGE };
  expect(manager.plan(plan).ok).toBe(true);
  await manager.submit("op");
  expect(manager.operation("op")?.state).toBe("SUBMITTED");
  return {
    manager,
    reconciler,
    state: (): string | undefined => manager.operation("op")?.state,
    /** SPLIT: whether all 100 pUSD can be reserved (the 10 released). Approvals: ready after an allowance sync. */
    releasedOrReady: (): boolean => {
      if (kind === "SPLIT") {
        const result = book.reserve({ reservationId: "probe-all", holderRef: "probe-holder", accountRef: ACCOUNT, assetId: PUSD, amount: "100" });
        if (result.ok) book.release({ reservationId: "probe-all" });
        return result.ok;
      }
      if (kind === "APPROVE_ERC20") {
        approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
        return approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE]).ready;
      }
      approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });
      return approvals.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready;
    },
  };
}

/**
 * The answer `values` as a Proxy: the FIRST read of `field` calls `act` (back
 * into the manager) before the descriptor is reported, and `requestId` names
 * the request the reconciler received last, as it is when that field is read.
 * `later`, if given, is a second trap of the same kind on a field the door
 * reads after `requestId` (the binding is settled by then; WP300C-R3-01).
 */
function namingTheLatest(
  values: Readonly<Record<string, unknown>>,
  field: string,
  act: () => void,
  reconciler: Reconciler,
  later?: { readonly field: string; readonly act: () => void },
) {
  let fired = false;
  let laterFired = false;
  let named: string | undefined;
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor(_target, key) {
        if (key === field && !fired) {
          fired = true;
          act();
        }
        if (later !== undefined && key === later.field && !laterFired) {
          laterFired = true;
          later.act();
        }
        if (key === "requestId") {
          named ??= reconciler.latest();
          return { value: named, writable: true, enumerable: true, configurable: true };
        }
        if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(values, key)) return undefined;
        return { value: values[key], writable: true, enumerable: true, configurable: true };
      },
      has: () => false,
    },
  );
  return {
    proxy,
    named: (): string => {
      if (named === undefined) throw new Error("requestId was never read");
      return named;
    },
  };
}

const DROPPED_A = { status: "DROPPED", transactionHash: TX_A };

describe("WP300C-R2-X1: an id received only during an answer's own read is never bound afterwards — a verbatim replay is refused too; a fresh request replaces it when it was the latest", () => {
  for (const kind of ["SPLIT", "APPROVE_ERC20", "APPROVE_ERC1155"] as const) {
    const values = { source: "AUTHORITATIVE_READ", state: kind === "SPLIT" ? "FAILED" : "CONFIRMED", transactionHash: TX_A, transactionId: null };
    for (const field of ["source", "state", "requestId"] as const) {
      it(`${kind}: a ${field} trap observes DROPPED(A), which issues and delivers request 2; the answer names request 2 and is refused — and a frozen plain replay naming request 2 is refused too; held`, async () => {
        const x = await inFlight(kind);
        x.manager.observe("op", DROPPED_A);
        expect(x.state()).toBe("RECONCILING");
        expect(x.reconciler.ids()).toHaveLength(1);
        const answer = namingTheLatest(values, field, () => void x.manager.observe("op", DROPPED_A), x.reconciler);
        const first = x.manager.resolveByReconciliation("op", answer.proxy);
        // Request 2 was received during the read, and named.
        expect(x.reconciler.ids()[1]).toBe(answer.named());
        expect(code(first)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
        const replay = x.manager.resolveByReconciliation("op", Object.freeze({ ...values, requestId: answer.named() }));
        expect(code(replay)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
        if (replay.ok) throw new Error("accepted");
        expect(replay.refusal.details["requestId"]).toBe(answer.named());
        expect(x.state()).toBe("RECONCILING");
        expect(x.releasedOrReady()).toBe(false);
        // Delivered again, any number of times: still refused.
        expect(code(x.manager.resolveByReconciliation("op", Object.freeze({ ...values, requestId: answer.named() })))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
        expect(x.releasedOrReady()).toBe(false);
      });
    }

    it(`(control: relabelled stale read, WP-290) ${kind}: the same values labelled with the latest request — one received before the read — bind, as on the base; no id can tell a read made before receipt`, async () => {
      const x = await inFlight(kind);
      x.manager.observe("op", DROPPED_A);
      const answer = namingTheLatest(values, "state", () => void x.manager.observe("op", DROPPED_A), x.reconciler);
      expect(code(x.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      const latest = x.reconciler.latest();
      expect(latest).not.toBe(answer.named());
      expect(code(x.manager.resolveByReconciliation("op", Object.freeze({ ...values, requestId: latest })))).toBe("ok");
      expect(x.state()).toBe(kind === "SPLIT" ? "FAILED" : "CONFIRMED");
      expect(x.releasedOrReady()).toBe(true);
    });
  }

  it("RECONCILING: when the refused answer's weighing raises no request (a MINED(A) report), the request it named was the latest — a fresh request replaces it at once, and FAILED(A) for the fresh one concludes (liveness)", async () => {
    const x = await inFlight("SPLIT");
    x.manager.observe("op", DROPPED_A);
    const answer = namingTheLatest(
      { source: "AUTHORITATIVE_READ", state: "MINED", transactionHash: TX_A, transactionId: null },
      "state",
      () => void x.manager.observe("op", DROPPED_A),
      x.reconciler,
    );
    expect(code(x.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    // Request 2 (named during the read) and its replacement, request 3.
    expect(x.reconciler.ids()).toHaveLength(3);
    expect(x.reconciler.ids()[1]).toBe(answer.named());
    const fresh = x.reconciler.received.at(-1);
    expect(fresh?.trigger).toBe(WALLET_OPERATION_UNKNOWN_TRIGGER);
    expect(fresh?.reason).toContain("this request replaces it");
    expect(x.manager.outstandingReconciliationRequests()).toEqual([]);
    // An answer naming request 2 is never bound; one naming request 3 is.
    expect(code(x.manager.resolveByReconciliation("op", failed(answer.named())))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(x.releasedOrReady()).toBe(false);
    expect(code(x.manager.resolveByReconciliation("op", failed(x.reconciler.latest())))).toBe("ok");
    expect(x.state()).toBe("FAILED");
    expect(x.releasedOrReady()).toBe(true);
  });

  it("RECONCILING while the executor call is pending: the replacement is owed, not sent (WP300-R7-X1) — it is sent when the executor answers, and FAILED(A) for it concludes", async () => {
    const h = harness("pending");
    h.plan();
    const submitted = h.manager.submit("op");
    h.manager.observe("op", DROPPED_A);
    expect(h.state()).toBe("RECONCILING");
    expect(h.reconciler.ids()).toHaveLength(1);
    const answer = namingTheLatest(
      { source: "AUTHORITATIVE_READ", state: "MINED", transactionHash: TX_A, transactionId: null },
      "state",
      () => void h.manager.observe("op", DROPPED_A),
      h.reconciler,
    );
    expect(code(h.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.reconciler.ids()[1]).toBe(answer.named());
    // Nothing more is sent while the executor call is pending.
    expect(h.reconciler.ids()).toHaveLength(2);
    expect(h.queued()).toEqual([]);
    h.release();
    await submitted;
    expect(h.reconciler.ids()).toHaveLength(3);
    expect(code(h.manager.resolveByReconciliation("op", failed(answer.named())))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.wholeReservable()).toBe(false);
    expect(code(h.manager.resolveByReconciliation("op", failed(h.reconciler.latest())))).toBe("ok");
    expect(h.state()).toBe("FAILED");
    expect(h.wholeReservable()).toBe(true);
  });

  it("FAILED and quarantined: the replacement is a fresh POSITION_BALANCE_DISCREPANCY request, and FAILED(A) for it lifts the quarantine", async () => {
    const x = await inFlight("SPLIT");
    x.manager.observe("op", DROPPED_A);
    expect(code(x.manager.resolveByReconciliation("op", failed(x.reconciler.latest())))).toBe("ok");
    expect(x.state()).toBe("FAILED");
    // A contradicting observation after the conclusion: quarantined, request 2.
    x.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(x.manager.operation("op")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_A}`] });
    expect(x.reconciler.ids()).toHaveLength(2);
    const answer = namingTheLatest(
      { source: "AUTHORITATIVE_READ", state: "MINED", transactionHash: TX_A, transactionId: null },
      "state",
      () => void x.manager.observe("op", DROPPED_A),
      x.reconciler,
    );
    expect(code(x.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(x.reconciler.ids()[2]).toBe(answer.named());
    expect(x.reconciler.ids()).toHaveLength(4);
    expect(x.reconciler.received.at(-1)?.trigger).toBe("POSITION_BALANCE_DISCREPANCY");
    expect(code(x.manager.resolveByReconciliation("op", failed(answer.named())))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(x.manager.operation("op")?.quarantined).toBe(true);
    expect(code(x.manager.resolveByReconciliation("op", failed(x.reconciler.latest())))).toBe("ok");
    expect(x.manager.operation("op")?.quarantined).toBe(false);
  });

  it("(control) when the refused answer's weighing raises a newer request itself, nothing more is sent: FAILED(A) is weighed, and request 3 is the only one after request 2", async () => {
    const x = await inFlight("SPLIT");
    x.manager.observe("op", DROPPED_A);
    const answer = namingTheLatest(
      { source: "AUTHORITATIVE_READ", state: "FAILED", transactionHash: TX_A, transactionId: null },
      "state",
      () => void x.manager.observe("op", DROPPED_A),
      x.reconciler,
    );
    expect(code(x.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(x.reconciler.ids()).toHaveLength(3);
    expect(x.reconciler.received.at(-1)?.reason).not.toContain("this request replaces it");
  });
});

// ---------------------------------------------------------- WP300C-R3-01 --

/** A MINED(A) report: weighed under reconciliation it raises no request, so a replacement is the only one raised. */
const MINED_A_ANSWER = Object.freeze({ source: "AUTHORITATIVE_READ", state: "MINED", transactionHash: TX_A, transactionId: null });

describe("WP300C-R3-01: a replacement request that cannot be delivered at once is queued — never lost, never delivered re-entrantly — and retry delivers it", () => {
  for (const where of ["RECONCILING", "FAILED and quarantined"] as const) {
    it(`${where}: the reconciler is down when the replacement is raised — it is queued, not lost; retry delivers it, and FAILED(A) for it ${where === "RECONCILING" ? "concludes" : "lifts the quarantine"} (liveness)`, async () => {
      const x = await inFlight("SPLIT");
      x.manager.observe("op", DROPPED_A);
      if (where === "FAILED and quarantined") {
        expect(code(x.manager.resolveByReconciliation("op", failed(x.reconciler.latest())))).toBe("ok");
        // A contradicting observation after the conclusion: quarantined.
        x.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
        expect(x.manager.operation("op")).toMatchObject({ state: "FAILED", quarantined: true });
      }
      const before = x.reconciler.ids().length;
      // The state trap delivers a request (the answer names it: recorded), then the reconciler goes down.
      const answer = namingTheLatest(
        MINED_A_ANSWER,
        "state",
        () => {
          x.manager.observe("op", DROPPED_A);
          x.reconciler.failing = true;
        },
        x.reconciler,
      );
      expect(code(x.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(x.reconciler.ids()).toHaveLength(before + 1);
      expect(x.reconciler.latest()).toBe(answer.named());
      // The replacement could not be delivered: it is queued, not lost.
      const queued = x.manager.outstandingReconciliationRequests();
      expect(queued).toHaveLength(1);
      const replacement = queued[0];
      if (replacement === undefined) throw new Error("no replacement queued");
      expect(replacement).toMatchObject({
        walletOperationId: "op",
        trigger: where === "RECONCILING" ? WALLET_OPERATION_UNKNOWN_TRIGGER : "POSITION_BALANCE_DISCREPANCY",
      });
      expect(replacement.reason).toContain("this request replaces it");
      expect(replacement.requestId).not.toBe(answer.named());
      expect(x.state()).toBe(where === "RECONCILING" ? "RECONCILING" : "FAILED");
      if (where === "RECONCILING") expect(x.releasedOrReady()).toBe(false);
      else expect(x.manager.operation("op")?.quarantined).toBe(true);
      // The reconciler is back: retry delivers the replacement, under its own id.
      x.reconciler.failing = false;
      expect(x.manager.retryReconciliationRequests()).toBe(1);
      expect(x.manager.outstandingReconciliationRequests()).toEqual([]);
      expect(x.reconciler.ids()).toHaveLength(before + 2);
      expect(x.reconciler.latest()).toBe(replacement.requestId);
      // The recorded id is never bound; FAILED(A) for the replacement is.
      expect(code(x.manager.resolveByReconciliation("op", failed(answer.named())))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(code(x.manager.resolveByReconciliation("op", failed(x.reconciler.latest())))).toBe("ok");
      expect(x.state()).toBe("FAILED");
      if (where === "RECONCILING") expect(x.releasedOrReady()).toBe(true);
      else expect(x.manager.operation("op")?.quarantined).toBe(false);
    });
  }

  it("RECONCILING: the replacement's token draw fails — it is queued, never delivered under its untokened id; retry sends a fresh request in its place, and FAILED(A) for that one concludes (liveness)", async () => {
    const tokens = new RequestTokens();
    let failDraws = false;
    const x = await inFlight("SPLIT", () => {
      if (failDraws) throw new Error("token source unavailable");
      return tokens.next();
    });
    x.manager.observe("op", DROPPED_A);
    // The state trap delivers request 2 (the answer names it: recorded), then the token source fails.
    const answer = namingTheLatest(
      MINED_A_ANSWER,
      "state",
      () => {
        x.manager.observe("op", DROPPED_A);
        failDraws = true;
      },
      x.reconciler,
    );
    expect(code(x.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(x.reconciler.ids()).toHaveLength(2);
    expect(x.reconciler.latest()).toBe(answer.named());
    // The replacement (request 3) has no token: it is queued, not lost, and never handed over under that id.
    const queued = x.manager.outstandingReconciliationRequests();
    expect(queued).toHaveLength(1);
    const untokened = queued[0];
    if (untokened === undefined) throw new Error("no replacement queued");
    expect(untokened.requestId).toBe(requestIdOf("op", 3, ""));
    expect(untokened.reason).toContain("this request replaces it");
    expect(x.state()).toBe("RECONCILING");
    expect(x.releasedOrReady()).toBe(false);
    // The source is back: retry sends a fresh request (a fresh draw) in its place.
    failDraws = false;
    expect(x.manager.retryReconciliationRequests()).toBe(1);
    expect(x.manager.outstandingReconciliationRequests()).toEqual([]);
    expect(x.reconciler.ids()).toHaveLength(3);
    expect(x.reconciler.ids()).not.toContain(untokened.requestId);
    expect(x.reconciler.received.at(-1)?.reason).toContain("this request replaces it");
    expect(code(x.manager.resolveByReconciliation("op", failed(answer.named())))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(code(x.manager.resolveByReconciliation("op", failed(untokened.requestId)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(x.releasedOrReady()).toBe(false);
    expect(code(x.manager.resolveByReconciliation("op", failed(x.reconciler.latest())))).toBe("ok");
    expect(x.state()).toBe("FAILED");
    expect(x.releasedOrReady()).toBe(true);
  });

  it("raised inside another operation's delivery: the replacement is queued, never delivered re-entrantly (one delivery at a time); retry delivers it, and FAILED(A) for it concludes", async () => {
    const h = harness("in-flight");
    h.plan();
    h.plan("op2");
    await h.manager.submit("op");
    // The executor throws for op2: it is under reconciliation too.
    await h.manager.submit("op2");
    h.manager.observe("op", DROPPED_A);
    expect(h.state()).toBe("RECONCILING");
    expect(h.state("op2")).toBe("RECONCILING");
    const op2Before = h.reconciler.ids("op2").length;
    let inner: string | undefined;
    const answer = namingTheLatest(MINED_A_ANSWER, "state", () => void h.manager.observe("op", DROPPED_A), h.reconciler, {
      // Read after requestId: the request the answer named is recorded by now.
      field: "transactionHash",
      act: () => {
        // op2's next request is delivered, and inside that delivery the reconciler answers "op" (a MINED(A) report
        // naming the recorded request): the replacement for "op" is raised inside another request's delivery.
        h.reconciler.onRequest = (request) => {
          if (request.walletOperationId !== "op2") return;
          h.reconciler.onRequest = undefined;
          inner = code(h.manager.resolveByReconciliation("op", Object.freeze({ ...MINED_A_ANSWER, requestId: answer.named() })));
        };
        h.manager.observe("op2", DROPPED_A);
      },
    });
    expect(code(h.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(inner).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.reconciler.ids("op2")).toHaveLength(op2Before + 1);
    // Never re-entrant: one delivery at a time.
    expect(h.reconciler.maxDepth).toBe(1);
    expect(h.reconciler.ids()).toHaveLength(2);
    expect(h.reconciler.latest()).toBe(answer.named());
    // Queued once, not raised again by the outer answer (its latest request is the replacement by then).
    expect(h.queued()).toHaveLength(1);
    const [replacement] = h.manager.outstandingReconciliationRequests();
    if (replacement === undefined) throw new Error("no replacement queued");
    expect(replacement).toMatchObject({ walletOperationId: "op", trigger: WALLET_OPERATION_UNKNOWN_TRIGGER });
    expect(replacement.reason).toContain("this request replaces it");
    expect(h.manager.outstandingReconciliationRequests()).toHaveLength(1);
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    expect(h.reconciler.maxDepth).toBe(1);
    expect(h.reconciler.latest()).toBe(replacement.requestId);
    expect(code(h.manager.resolveByReconciliation("op", failed(answer.named())))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(code(h.manager.resolveByReconciliation("op", failed(h.reconciler.latest())))).toBe("ok");
    expect(h.state()).toBe("FAILED");
  });
});

// ---------------------------------------------------------- WP300C-R3-02 --

describe("WP300C-R3-02: no replacement where nothing awaits an answer — the recorded id is the latest request of an operation that is terminal and not quarantined, or back in flight", () => {
  it("terminal, not quarantined: inside the delivery the answer's state trap causes, a synchronous requester concludes the operation (FAILED(A) for request 1); the answer names request 1, which is recorded — and no request replaces it", async () => {
    const x = await inFlight("SPLIT");
    let inner: string | undefined;
    const answer = namingTheLatest(
      { source: "AUTHORITATIVE_READ", state: "FAILED", transactionHash: TX_A, transactionId: null },
      "state",
      () => {
        x.reconciler.onRequest = (request) => {
          x.reconciler.onRequest = undefined;
          // Read after receiving request 1: bound to it.
          inner = code(x.manager.resolveByReconciliation("op", failed(request.requestId)));
        };
        x.manager.observe("op", DROPPED_A);
      },
      x.reconciler,
    );
    expect(code(x.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(inner).toBe("ok");
    expect(x.manager.operation("op")).toMatchObject({ state: "FAILED", quarantined: false });
    expect(x.releasedOrReady()).toBe(true);
    // Request 1 is the latest and recorded, and nothing awaits an answer: nothing was raised.
    expect(x.reconciler.ids()).toEqual([answer.named()]);
    expect(x.manager.outstandingReconciliationRequests()).toEqual([]);
    // A replay naming it raises nothing either.
    expect(code(x.manager.resolveByReconciliation("op", failed(answer.named())))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(x.reconciler.ids()).toHaveLength(1);
    expect(x.manager.outstandingReconciliationRequests()).toEqual([]);
  });

  it("back in flight: the executor threw while the reconciler was down (UNKNOWN, request 1 queued); the answer's state trap retries, and inside that delivery a synchronous requester answers 'still in flight' (MINED(A)) for request 1; the answer names request 1, which is recorded, while the operation is MINED — and no request replaces it", async () => {
    const h = harness("threw");
    h.plan();
    h.reconciler.failing = true;
    await h.manager.submit("op");
    expect(h.state()).toBe("UNKNOWN");
    expect(h.queued()).toHaveLength(1);
    h.reconciler.failing = false;
    let retried: number | undefined;
    let inner: string | undefined;
    const answer = namingTheLatest(
      MINED_A_ANSWER,
      "state",
      () => {
        h.reconciler.onRequest = (request) => {
          h.reconciler.onRequest = undefined;
          // Read after receiving request 1: bound to it, and the operation is back in flight.
          inner = code(h.manager.resolveByReconciliation("op", Object.freeze({ ...MINED_A_ANSWER, requestId: request.requestId })));
        };
        retried = h.manager.retryReconciliationRequests();
      },
      h.reconciler,
    );
    expect(code(h.manager.resolveByReconciliation("op", answer.proxy))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(retried).toBe(1);
    expect(inner).toBe("ok");
    expect(h.state()).toBe("MINED");
    // Request 1 is the latest and recorded, and the operation is in flight: nothing was raised.
    expect(h.reconciler.ids()).toEqual([answer.named()]);
    expect(h.queued()).toEqual([]);
    // The operation goes on in flight: FAILED(A) observed concludes it, and nothing more was asked.
    expect(code(h.manager.observe("op", { status: "FAILED", transactionHash: TX_A, transactionId: null }))).toBe("ok");
    expect(h.state()).toBe("FAILED");
    expect(h.wholeReservable()).toBe(true);
    expect(h.reconciler.ids()).toHaveLength(1);
  });
});

describe("WP300C-R2-X2: the refusal of an answer naming a request received during its own read says so — not 'never received'", () => {
  it("a state trap delivers request 2, which the answer names: refused, and the reason says the request was not received when the read began (delivered only during it)", async () => {
    const x = await inFlight("SPLIT");
    x.manager.observe("op", DROPPED_A);
    const answer = namingTheLatest(
      { source: "AUTHORITATIVE_READ", state: "FAILED", transactionHash: TX_A, transactionId: null },
      "state",
      () => void x.manager.observe("op", DROPPED_A),
      x.reconciler,
    );
    const result = x.manager.resolveByReconciliation("op", answer.proxy);
    expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    if (result.ok) throw new Error("accepted");
    expect(result.refusal.details["requestId"]).toBe(answer.named());
    expect(result.refusal.message).not.toContain("never received");
    expect(result.refusal.message).toContain("had not received for this operation when the read of an answer naming it began");
    expect(result.refusal.message).toContain("delivered only during that answer's own read");
  });
});

// ------------------------------------------------------------- WP300C-J7 --

describe("WP300C-J7, WP300C-R2-X2: a request issued but not received is refused as 'not received' (when an answer naming it was read), not 'not issued'", () => {
  it("under reconciliation: a FAILED(A) naming the operation's queued request is refused, and the reason says the reconciler had not received it", async () => {
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
    expect(result.refusal.message).toContain("had not received");
    expect(result.refusal.message).not.toContain("not issued");
    expect(result.refusal.details["requestId"]).toBe(queued);
  });

  it("in flight: a FAILED(A) naming an id never received is refused SUPERSEDED, and what supersedes it says the reconciler had not received it", async () => {
    const h = harness("in-flight");
    h.plan();
    await h.manager.submit("op");
    const result = h.manager.resolveByReconciliation("op", failed(requestIdOf("op", 1, h.tokens.peek())));
    expect(code(result)).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    if (result.ok) throw new Error("accepted");
    expect(String(result.refusal.details["supersededBy"])).toContain("had not received");
    expect(String(result.refusal.details["supersededBy"])).not.toContain("not issued");
  });
});
