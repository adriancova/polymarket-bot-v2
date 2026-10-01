/**
 * WP-300c round 1: pins for WP300C-J1 (HIGH), found by the round-1 verifiers
 * (Opus and gpt-6-astra, reconciled).
 *
 * WP300C-J1. Request ids were predictable (`compositeKey("wallet-op",
 * operationId, "reconciliation", n)`). A reconciler could READ for the
 * predicted next request before that request existed and hold the answer
 * back; once a contradicting observation issued the request, the held answer
 * was bound to it and current:
 * - a SPLIT concluded FAILED and released all its collateral (P1);
 * - an APPROVE_ERC20 or APPROVE_ERC1155 concluded CONFIRMED and, after a CLOB
 *   allowance sync, was READY (P2).
 * The same read bound to the request it was made for was refused as
 * superseded. Recording ids named before receipt (WP-300c round 0) cannot see
 * this: the manager never saw the name before the id was issued.
 *
 * The fix (the manager's header, "REQUEST IDS"): every request id carries a
 * TOKEN drawn from an injected `requestToken` source, which the composition
 * root binds to a CSPRNG. A reconciler cannot know a token before it receives
 * the request, so the best it can predict (the received id with the ordinal
 * advanced, `predictedRequestId`) is an id never issued, and the held answer
 * is never bound. Layer 1 stays deterministic given the source. A draw that
 * fails leaves its request undelivered until retry draws again.
 *
 * Every pin fails on the round-0 candidate (`dcad467`) and on the base
 * (`28d542a`), except those marked "(control)". The "(control: the token
 * contract)" pin shows what the guarantee rests on: with a source the
 * reconciler can read ahead, the held answer IS bound again.
 *
 * All executors and reconcilers are in-memory mocks. Nothing is signed or sent.
 */

import { describe, expect, it } from "vitest";

import * as inventory from "../../../packages/inventory/src/index.js";
import {
  ApprovalTracker,
  WalletOperationManager,
  type ReconciliationRequest,
  type WalletOperationPlan,
} from "../../../packages/inventory/src/index.js";
import {
  ACCOUNT,
  CONDITION,
  CTF_EXCHANGE,
  NO,
  PUSD,
  RequestTokens,
  USDC_E,
  YES,
  keyParts,
  predictedRequestId,
  requestIdOf,
  seededBook,
} from "./helpers.js";

const TX_A = "0x" + "a".repeat(64);

/** The package's bound (a fallback for a tree that has none, so the pin still runs there). */
const MAX_TOKEN = Number((inventory as Readonly<Record<string, unknown>>)["MAX_REQUEST_TOKEN_LENGTH"] ?? 128);

const code = (result: { ok: boolean; refusal?: { code: string } }) => (result.ok ? "ok" : result.refusal?.code);

class Reconciler {
  readonly received: ReconciliationRequest[] = [];
  failing = false;
  request(request: ReconciliationRequest): void {
    if (this.failing) throw new Error("reconciler unavailable");
    this.received.push(request);
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

type Kind = "SPLIT" | "APPROVE_ERC20" | "APPROVE_ERC1155";

const PLANS: Readonly<Record<Kind, Readonly<Record<string, unknown>>>> = {
  SPLIT: { type: "SPLIT", operationId: "op", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" },
  APPROVE_ERC20: { type: "APPROVE_ERC20", operationId: "op", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" },
  APPROVE_ERC1155: { type: "APPROVE_ERC1155", operationId: "op", accountRef: ACCOUNT, spender: CTF_EXCHANGE },
};

/** "op" planned; the executor answers SUBMITTED(A), or throws (`threw`). */
function harness(kind: Kind, options: { readonly requestToken?: () => string; readonly threw?: boolean } = {}) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const approvals = new ApprovalTracker();
  const reconciler = new Reconciler();
  const tokens = new RequestTokens();
  const manager = new WalletOperationManager({
    requestToken: options.requestToken ?? tokens.next,
    book,
    approvals,
    reconciler,
    executor: {
      submit: () =>
        options.threw === true ? Promise.reject(new Error("socket closed")) : Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }),
    },
  });
  expect(manager.plan(PLANS[kind] as WalletOperationPlan).ok).toBe(true);
  return {
    book,
    approvals,
    reconciler,
    manager,
    tokens,
    state: (): string | undefined => manager.operation("op")?.state,
    queued: (): string[] =>
      manager
        .outstandingReconciliationRequests()
        .filter((request) => request.walletOperationId === "op")
        .map((request) => request.requestId),
    /** Whether all 100 pUSD can be reserved now: false while the SPLIT holds its 10. */
    wholeReservable: (): boolean => {
      const result = book.reserve({ reservationId: "probe-all", holderRef: "probe-holder", accountRef: ACCOUNT, assetId: PUSD, amount: "100" });
      if (result.ok) book.release({ reservationId: "probe-all" });
      return result.ok;
    },
    /** A CLOB allowance sync for the approval, then whether trading on it is ready. */
    syncedReady: (): boolean => {
      if (kind === "APPROVE_ERC20") {
        approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
        return approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE]).ready;
      }
      approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });
      return approvals.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready;
    },
  };
}

const authoritative = (state: string, requestId: string) =>
  Object.freeze({ source: "AUTHORITATIVE_READ", state, transactionHash: TX_A, transactionId: null, requestId });

/** In flight, then an unrecognised report about A: RECONCILING under request 1. */
async function underRequest1(h: ReturnType<typeof harness>): Promise<string> {
  await h.manager.submit("op");
  h.manager.observe("op", { status: "UNKNOWN", transactionHash: TX_A, transactionId: null });
  expect(h.state()).toBe("RECONCILING");
  expect(h.reconciler.ids()).toHaveLength(1);
  return h.reconciler.latest();
}

// ---------------------------------------------------------- the held read --

describe("WP300C-J1: a read held back for the predicted next request is never bound to it", () => {
  const INTERVENING = {
    "an observed CONFIRMED(A)": { status: "CONFIRMED", transactionHash: TX_A, transactionId: null },
    "an unrecognised report naming A (DROPPED)": { status: "DROPPED", transactionHash: TX_A, transactionId: null },
  } as const;

  for (const [label, observation] of Object.entries(INTERVENING)) {
    it(`SPLIT: FAILED(A) read for the predicted request 2, held back while ${label} issues request 2, then delivered — refused; the collateral stays reserved (P1)`, async () => {
      const h = harness("SPLIT");
      const request1 = await underRequest1(h);
      // The best a reconciler that knows the id format can name for the next request.
      const predicted = predictedRequestId(request1);
      const held = authoritative("FAILED", predicted);
      h.manager.observe("op", observation);
      expect(h.reconciler.ids()).toHaveLength(2); // request 2 was issued and received
      const result = h.manager.resolveByReconciliation("op", held);
      expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.state()).toBe("RECONCILING");
      expect(h.wholeReservable()).toBe(false);
      expect(h.reconciler.ids()).not.toContain(predicted);
      // Liveness: a FAILED(A) read for the request actually received concludes and releases.
      expect(code(h.manager.resolveByReconciliation("op", authoritative("FAILED", h.reconciler.latest())))).toBe("ok");
      expect(h.state()).toBe("FAILED");
      expect(h.wholeReservable()).toBe(true);
    });
  }

  for (const kind of ["APPROVE_ERC20", "APPROVE_ERC1155"] as const) {
    it(`${kind}: CONFIRMED(A) read for the predicted request 2, held back while DROPPED(A) issues request 2, then delivered — refused; an allowance sync does not make it ready (P2)`, async () => {
      const h = harness(kind);
      const request1 = await underRequest1(h);
      const predicted = predictedRequestId(request1);
      const held = authoritative("CONFIRMED", predicted);
      h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A, transactionId: null });
      expect(h.reconciler.ids()).toHaveLength(2);
      const result = h.manager.resolveByReconciliation("op", held);
      expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.state()).toBe("RECONCILING");
      expect(h.syncedReady()).toBe(false);
      expect(h.reconciler.ids()).not.toContain(predicted);
      // Liveness: a CONFIRMED(A) read for the request actually received, then a sync after it: ready.
      expect(code(h.manager.resolveByReconciliation("op", authoritative("CONFIRMED", h.reconciler.latest())))).toBe("ok");
      expect(h.state()).toBe("CONFIRMED");
      expect(h.syncedReady()).toBe(true);
    });
  }

  it("(control) the same held read bound to request 1, the one received when it was made, is refused SUPERSEDED; held", async () => {
    const h = harness("SPLIT");
    const request1 = await underRequest1(h);
    const held = authoritative("FAILED", request1);
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(code(h.manager.resolveByReconciliation("op", held))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    expect(h.state()).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
  });

  it("(control: the token contract) with a source the reconciler can read ahead, the held read IS bound again: the guarantee is exactly the source's unpredictability", async () => {
    const h = harness("SPLIT");
    await underRequest1(h);
    // A reconciler that knows the source: it names the exact id request 2 will carry.
    const clairvoyant = requestIdOf("op", 2, h.tokens.peek());
    const held = authoritative("FAILED", clairvoyant);
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.reconciler.latest()).toBe(clairvoyant);
    expect(code(h.manager.resolveByReconciliation("op", held))).toBe("ok");
    expect(h.state()).toBe("FAILED");
    expect(h.wholeReservable()).toBe(true);
  });
});

// ------------------------------------------------------- the token source --

describe("WP300C-J1: the request-token source", () => {
  it("every request id carries the token drawn for it, one draw per id (the id format: wallet-op, operation, reconciliation, n, token)", async () => {
    const drawn: string[] = [];
    const tokens = new RequestTokens("t-");
    const h = harness("SPLIT", {
      requestToken: () => {
        const token = tokens.next();
        drawn.push(token);
        return token;
      },
    });
    await underRequest1(h);
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    const ids = h.reconciler.ids();
    expect(ids).toHaveLength(2);
    expect(drawn).toEqual(["t-1", "t-2"]);
    expect(ids.map((id) => keyParts(id))).toEqual([
      ["wallet-op", "op", "reconciliation", "1", "t-1"],
      ["wallet-op", "op", "reconciliation", "2", "t-2"],
    ]);
  });

  it(`a token of exactly ${String(MAX_TOKEN)} characters is accepted`, async () => {
    const long = "x".repeat(MAX_TOKEN);
    const h = harness("SPLIT", { requestToken: () => long });
    await underRequest1(h);
    expect(keyParts(h.reconciler.latest())?.[4]).toBe(long);
  });

  it("a manager without a token source is refused when it is built (every id would be predictable)", () => {
    const deps = {
      book: seededBook({ [PUSD]: "100" }),
      approvals: new ApprovalTracker(),
      executor: { submit: () => Promise.resolve({ status: "NOT_SENT" }) },
      reconciler: new Reconciler(),
    };
    expect(() => new WalletOperationManager(deps as unknown as ConstructorParameters<typeof WalletOperationManager>[0])).toThrow(TypeError);
    expect(
      () => new WalletOperationManager({ ...deps, requestToken: "not a function" } as unknown as ConstructorParameters<typeof WalletOperationManager>[0]),
    ).toThrow(TypeError);
  });

  const FAILED_DRAWS: Readonly<Record<string, () => unknown>> = {
    "throws": () => {
      throw new Error("entropy unavailable");
    },
    "returns a number": () => 7,
    "returns an empty string": () => "",
    [`returns ${String(MAX_TOKEN + 1)} characters`]: () => "x".repeat(MAX_TOKEN + 1),
  };

  for (const [how, bad] of Object.entries(FAILED_DRAWS)) {
    it(`a draw that ${how} leaves the request undelivered: the operation stays UNKNOWN and held, an answer naming that id is never bound, and retry delivers a fresh request once the source draws again`, async () => {
      let broken = true;
      const tokens = new RequestTokens();
      const h = harness("SPLIT", { threw: true, requestToken: () => (broken ? bad() : tokens.next()) as string });
      await h.manager.submit("op");
      expect(h.state()).toBe("UNKNOWN");
      expect(h.reconciler.received).toEqual([]);
      const [undelivered] = h.queued();
      if (undelivered === undefined) throw new Error("no queued request");
      expect(h.wholeReservable()).toBe(false);
      // Still broken: retry draws again, fails again, delivers nothing.
      expect(h.manager.retryReconciliationRequests()).toBe(0);
      expect(h.reconciler.received).toEqual([]);
      expect(h.state()).toBe("UNKNOWN");
      broken = false;
      expect(h.manager.retryReconciliationRequests()).toBe(1);
      expect(h.state()).toBe("RECONCILING");
      expect(h.reconciler.ids()).toHaveLength(1);
      expect(keyParts(h.reconciler.latest())?.[4]).toBe("k1");
      // The id built without a token was never received: an answer naming it is never bound.
      expect(code(h.manager.resolveByReconciliation("op", authoritative("FAILED", undelivered)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
      expect(h.state()).toBe("RECONCILING");
      expect(h.wholeReservable()).toBe(false);
      // Liveness: the answer to the request received concludes.
      expect(code(h.manager.resolveByReconciliation("op", authoritative("FAILED", h.reconciler.latest())))).toBe("ok");
      expect(h.state()).toBe("FAILED");
    });
  }

  it("a token the source returned before is a failed draw (it was predictable): that request is not delivered until retry draws a fresh one", async () => {
    let repeat = true;
    const tokens = new RequestTokens("fresh-");
    const h = harness("SPLIT", { requestToken: () => (repeat ? "same" : tokens.next()) });
    const request1 = await underRequest1(h);
    expect(keyParts(request1)?.[4]).toBe("same");
    // Evidence weighed under reconciliation raises request 2; its draw repeats "same".
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.reconciler.ids()).toEqual([request1]);
    expect(h.queued()).toHaveLength(1);
    expect(h.state()).toBe("RECONCILING");
    expect(h.wholeReservable()).toBe(false);
    repeat = false;
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    expect(h.reconciler.ids()).toHaveLength(2);
    expect(keyParts(h.reconciler.latest())?.[4]).toBe("fresh-1");
    expect(code(h.manager.resolveByReconciliation("op", authoritative("FAILED", h.reconciler.latest())))).toBe("ok");
    expect(h.state()).toBe("FAILED");
  });
});
