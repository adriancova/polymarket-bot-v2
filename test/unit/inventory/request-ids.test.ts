/**
 * WP-300c: pins for WP-300b known risk 1, predictable request ids.
 *
 * Request ids are `compositeKey("wallet-op", operationId, "reconciliation", n)`.
 * An answer naming an operation's NEXT request id before that request existed
 * was refused (a request not issued), but once the id was issued the same
 * answer, delivered again, was bound to it and current: it concluded the
 * operation and released its reservation (WP-300b's `nextid-probe`, both
 * routes). The WP-300b round-1 verifier found a variant: an id issued but
 * never delivered (queued while the reconciler was down) was accepted too.
 *
 * The fix (the header's "REQUEST IDS"): an answer is bound only to a request
 * the reconciler has RECEIVED, and every id an answer names before that is
 * recorded and never issued — the next id skips it, and a queued request it
 * names is replaced by a fresh one. Pins marked "(control)" pass on the base
 * too; every other pin fails on the base (`28d542a`).
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
import { ACCOUNT, CONDITION, NO, PUSD, USDC_E, YES, seededBook } from "./helpers.js";

const TX_A = "0x" + "a".repeat(64);

/** The id the manager gives operation `operationId`'s `n`-th request (the documented format). */
const idOf = (operationId: string, n: number): string =>
  `9:wallet-op;${String(operationId.length)}:${operationId};14:reconciliation;${String(String(n).length)}:${String(n)};`;

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

type Route = "pending" | "in-flight" | "threw";

function harness(route: Route) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const reconciler = new Reconciler();
  let release: (value: unknown) => void = () => undefined;
  const executor: WalletOperationExecutor = {
    submit: (submission) =>
      submission.operationId !== "op" || route === "threw"
        ? Promise.reject(new Error("socket closed"))
        : route === "in-flight"
          ? Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null })
          : new Promise<unknown>((resolve) => {
              release = resolve;
            }),
  };
  const manager = new WalletOperationManager({ book, approvals: new ApprovalTracker(), executor, reconciler });
  return {
    book,
    reconciler,
    manager,
    release: (): void => release({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }),
    plan: (operationId = "op"): void => {
      expect(manager.plan({ type: "SPLIT", operationId, accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }).ok).toBe(true);
    },
    state: (operationId = "op"): string | undefined => manager.operation(operationId)?.state,
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
      const next = idOf("op", 1);
      expect(next).toBe("9:wallet-op;2:op;14:reconciliation;1:1;"); // the probe's NEXT
      const first = h.manager.resolveByReconciliation("op", failed(next));
      expect(code(first)).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      if (route === "pending") {
        h.release();
        await submitting;
      }
      // The request raised skips the id the answer named.
      expect(h.reconciler.ids()).toEqual([idOf("op", 2)]);
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
    const named = [idOf("op", 1), idOf("op", 2), idOf("op", 3)];
    for (const id of named) expect(code(h.manager.resolveByReconciliation("op", failed(id)))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    await h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
    expect(h.state()).toBe("RECONCILING");
    expect(h.reconciler.ids()).toEqual([idOf("op", 4)]);
    for (const id of named) {
      expect(code(h.manager.resolveByReconciliation("op", failed(id))), id).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.state()).toBe("RECONCILING");
    }
    expect(h.wholeReservable()).toBe(false);
    for (const id of named) expect(h.reconciler.ids()).not.toContain(id);
  });

  it("an id named in an answer to an operation that does not exist yet is never issued to it", async () => {
    const h = harness("threw");
    expect(code(h.manager.resolveByReconciliation("op", failed(idOf("op", 1), null)))).toBe("WALLET_OP_NOT_FOUND");
    h.plan();
    await h.manager.submit("op");
    expect(h.state()).toBe("RECONCILING");
    expect(h.reconciler.ids()).toEqual([idOf("op", 2)]);
    expect(code(h.manager.resolveByReconciliation("op", failed(idOf("op", 1), null)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.state()).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
  });

  it("an id named in an answer addressed to ANOTHER operation is never issued under that id", async () => {
    const h = harness("threw");
    h.plan("op2");
    await h.manager.submit("op2");
    expect(code(h.manager.resolveByReconciliation("op2", failed(idOf("op", 1), null)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    h.plan();
    await h.manager.submit("op");
    expect(h.reconciler.ids()).toEqual([idOf("op", 2)]);
    expect(code(h.manager.resolveByReconciliation("op", failed(idOf("op", 1), null)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(h.state()).toBe("RECONCILING");
  });

  it("a queued request (the reconciler was down; its delivery threw) is not received: an answer naming it is refused, and it is never delivered under that id", async () => {
    const h = harness("threw");
    h.plan();
    h.reconciler.failing = true;
    await h.manager.submit("op");
    expect(h.state()).toBe("UNKNOWN");
    const queued = h.manager.outstandingReconciliationRequests().map((request) => request.requestId);
    expect(queued).toEqual([idOf("op", 1)]);
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
    expect(h.reconciler.ids()).toEqual([idOf("op", 1)]);
    h.reconciler.failing = true;
    // An observation weighed under reconciliation raises a plain request; the reconciler is down, so it is queued.
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
    const [queued] = h.manager.outstandingReconciliationRequests();
    expect(queued?.requestId).toBe(idOf("op", 2));
    // Named (in an answer addressed to another operation) before it was delivered.
    h.manager.resolveByReconciliation("op2", failed(idOf("op", 2), null));
    h.reconciler.failing = false;
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    expect(h.reconciler.ids()).toEqual([idOf("op", 1), idOf("op", 3)]);
    const fresh = h.reconciler.received.at(-1);
    expect(fresh).toMatchObject({ trigger: queued?.trigger, reason: queued?.reason, transactionHashes: [TX_A] });
    expect(code(h.manager.resolveByReconciliation("op", failed(idOf("op", 2))))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(code(h.manager.resolveByReconciliation("op", failed(idOf("op", 3))))).toBe("ok");
    expect(h.state()).toBe("FAILED");
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
    expect(h.reconciler.ids()).toEqual([idOf("op", 1)]);
    expect(code(h.manager.resolveByReconciliation("op", failed(idOf("op", 1))))).toBe("ok");
    expect(h.state()).toBe("FAILED");
  });
});
