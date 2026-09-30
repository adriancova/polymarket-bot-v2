/**
 * WP-300: the wallet-operation state machine (§9.14; ADR-006 §8).
 *
 * Acceptance 3: an unknown wallet operation triggers reconciliation. Every
 * route into UNKNOWN is exercised (executor throw, unrecognised executor
 * result, unrecognised observation, a confirmation missing its required
 * evidence), and each one must (a) request reconciliation with the WP-040
 * trigger `WALLET_OPERATION_UNKNOWN`, (b) move to RECONCILING, (c) keep the
 * reservations held and assert no effect, and (d) leave RECONCILING only on
 * authoritative evidence.
 *
 * All executors here are in-memory mocks. Nothing is signed or sent.
 */

import { describe, expect, it } from "vitest";

import {
  ApprovalTracker,
  isLegalWalletTransition,
  WALLET_OPERATION_STATES,
  WALLET_OPERATION_TRANSITIONS,
  WalletOperationManager,
  type ReconciliationRequest,
  type WalletOperationExecutor,
  type WalletOperationSubmission,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, CTF_EXCHANGE, NO, PUSD, USDC_E, YES, seededBook } from "./helpers.js";

const TX = "0x0000000000000000000000000000000000000000000000000000000000000501";

class MockExecutor implements WalletOperationExecutor {
  readonly submitted: WalletOperationSubmission[] = [];
  constructor(readonly respond: (submission: WalletOperationSubmission) => unknown | Promise<unknown>) {}
  async submit(submission: WalletOperationSubmission): Promise<unknown> {
    this.submitted.push(submission);
    return this.respond(submission);
  }
}

class RecordingReconciler {
  readonly requests: ReconciliationRequest[] = [];
  failing = false;
  request(request: ReconciliationRequest): void {
    if (this.failing) throw new Error("reconciler queue unavailable");
    this.requests.push(request);
  }
}

function harness(
  respond: (s: WalletOperationSubmission) => unknown | Promise<unknown> = () => ({
    status: "SUBMITTED",
    transactionHash: TX,
    transactionId: "sanitized-transaction-id-0501",
  }),
  balances: Readonly<Record<string, string>> = { [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" },
) {
  const book = seededBook(balances);
  const approvals = new ApprovalTracker();
  const executor = new MockExecutor(respond);
  const reconciler = new RecordingReconciler();
  const manager = new WalletOperationManager({ book, approvals, executor, reconciler });
  return { book, approvals, executor, reconciler, manager };
}

const split = (operationId = "op-split-1", amount = "25") => ({
  type: "SPLIT",
  operationId,
  accountRef: ACCOUNT,
  conditionId: CONDITION,
  amount,
});

describe("transition table", () => {
  it("is the §9.14 state list, with terminal CONFIRMED/FAILED and UNKNOWN leading only to RECONCILING", () => {
    expect(WALLET_OPERATION_STATES).toEqual(["PLANNED", "SUBMITTED", "MINED", "CONFIRMED", "FAILED", "UNKNOWN", "RECONCILING"]);
    expect(WALLET_OPERATION_TRANSITIONS.CONFIRMED).toEqual([]);
    expect(WALLET_OPERATION_TRANSITIONS.FAILED).toEqual([]);
    expect(WALLET_OPERATION_TRANSITIONS.UNKNOWN).toEqual(["RECONCILING"]);
    // UNKNOWN can never become FAILED (or anything else) directly: no timeout path.
    for (const to of WALLET_OPERATION_STATES) {
      expect(isLegalWalletTransition("UNKNOWN", to)).toBe(to === "RECONCILING");
    }
  });
});

describe("split / merge / redeem / wrap / unwrap lifecycles", () => {
  it("SPLIT: reserves pUSD at plan, and on CONFIRMED converts a pUSD into a YES and a NO each", async () => {
    const { book, manager, executor } = harness();
    const planned = manager.plan(split());
    expect(planned.ok && planned.value.state).toBe("PLANNED");
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ reserved: "25", available: "75" });
    const submitted = await manager.submit("op-split-1");
    expect(submitted.ok && submitted.value.state).toBe("SUBMITTED");
    expect(executor.submitted).toHaveLength(1);
    expect(manager.observe("op-split-1", { status: "MINED", transactionHash: TX }).ok).toBe(true);
    const confirmed = manager.observe("op-split-1", { status: "CONFIRMED", transactionHash: TX, transactionId: null });
    expect(confirmed.ok && confirmed.value).toMatchObject({ state: "CONFIRMED", effectsApplied: true, transactionId: null });
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "75", reserved: "0", available: "75" });
    expect(book.line(ACCOUNT, YES)?.actual).toBe("45");
    expect(book.line(ACCOUNT, NO)?.actual).toBe("45");
    expect(manager.events("op-split-1").map((e) => e.newState)).toEqual(["PLANNED", "SUBMITTED", "MINED", "CONFIRMED"]);
    expect(book.checkInvariants()).toEqual([]);
  });

  it("SPLIT is refused without enough available pUSD", () => {
    const { manager } = harness(undefined, { [PUSD]: "10" });
    const planned = manager.plan(split("op", "25"));
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.code).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
  });

  it("MERGE: needs a balanced available YES+NO set, all or nothing", async () => {
    const { book, manager } = harness(undefined, { [PUSD]: "0", [YES]: "10", [NO]: "3" });
    const refused = manager.plan({ type: "MERGE", operationId: "m1", accountRef: ACCOUNT, conditionId: CONDITION, amount: "5" });
    expect(refused.ok).toBe(false);
    expect(book.line(ACCOUNT, YES)?.reserved).toBe("0"); // the YES half was rolled back
    expect(manager.plan({ type: "MERGE", operationId: "m2", accountRef: ACCOUNT, conditionId: CONDITION, amount: "3" }).ok).toBe(true);
    await manager.submit("m2");
    manager.observe("m2", { status: "CONFIRMED", transactionHash: TX, transactionId: "sanitized-transaction-id-0502" });
    expect(book.line(ACCOUNT, YES)?.actual).toBe("7");
    expect(book.line(ACCOUNT, NO)?.actual).toBe("0");
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("3");
  });

  it("REDEEM: refuses a CANCELLED market (U-10) and non-terminal outcomes; credits only the observed payout", async () => {
    const { book, manager } = harness();
    const base = { type: "REDEEM", accountRef: ACCOUNT, conditionId: CONDITION, yesAmount: "20" };
    const cancelled = manager.plan({ ...base, operationId: "r0", resolution: "CANCELLED" });
    expect(cancelled.ok).toBe(false);
    if (!cancelled.ok) expect(cancelled.refusal.code).toBe("WALLET_OP_REDEEM_CANCELLED_UNVERIFIED");
    for (const resolution of ["DISPUTED", "PENDING", "PENDING_CLARIFICATION", "yes", undefined]) {
      const r = manager.plan({ ...base, operationId: `r-${String(resolution)}`, resolution });
      expect(r.ok, String(resolution)).toBe(false);
      if (!r.ok) expect(r.refusal.code).toBe("WALLET_OP_REDEEM_OUTCOME_NOT_TERMINAL");
    }
    expect(manager.plan({ ...base, operationId: "r1", resolution: "YES_WIN" }).ok).toBe(true);
    await manager.submit("r1");
    manager.observe("r1", { status: "CONFIRMED", transactionHash: TX, transactionId: null, credited: "20" });
    expect(book.line(ACCOUNT, YES)?.actual).toBe("0");
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("120");
  });

  it("WRAP: USDC.e → pUSD credited from the observed amount, never computed", async () => {
    const { book, manager } = harness();
    expect(manager.plan({ type: "WRAP_COLLATERAL", operationId: "w1", accountRef: ACCOUNT, amount: "50" }).ok).toBe(true);
    expect(book.line(ACCOUNT, USDC_E)?.reserved).toBe("50");
    await manager.submit("w1");
    manager.observe("w1", { status: "CONFIRMED", transactionHash: TX, transactionId: null, credited: "49.99" });
    expect(book.line(ACCOUNT, USDC_E)?.actual).toBe("0");
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("149.99");
  });

  it("UNWRAP: pUSD → USDC.e in the same account, and refused when no USDC.e asset is registered", async () => {
    const { book, manager } = harness();
    expect(manager.plan({ type: "UNWRAP_COLLATERAL", operationId: "u1", accountRef: ACCOUNT, amount: "10" }).ok).toBe(true);
    await manager.submit("u1");
    manager.observe("u1", { status: "CONFIRMED", transactionHash: TX, transactionId: null, credited: "10" });
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("90");
    expect(book.line(ACCOUNT, USDC_E)?.actual).toBe("60");

    const bare = seededBook({ [PUSD]: "100" }, { withUsdcE: false });
    const manager2 = new WalletOperationManager({
      book: bare,
      approvals: new ApprovalTracker(),
      executor: new MockExecutor(() => ({})),
      reconciler: new RecordingReconciler(),
    });
    expect(manager2.plan({ type: "UNWRAP_COLLATERAL", operationId: "u2", accountRef: ACCOUNT, amount: "10" }).ok).toBe(false);
    expect(manager2.plan({ type: "WRAP_COLLATERAL", operationId: "w2", accountRef: ACCOUNT, amount: "10" }).ok).toBe(false);
  });

  it("FAILED (by observation) and NOT_SENT (by the executor) release the reservation", async () => {
    const { book, manager } = harness();
    manager.plan(split("f1", "10"));
    await manager.submit("f1");
    expect(manager.observe("f1", { status: "FAILED" }).ok).toBe(true);
    expect(manager.operation("f1")?.state).toBe("FAILED");
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "0" });

    const notSent = harness(() => ({ status: "NOT_SENT" }));
    notSent.manager.plan(split("f2", "10"));
    await notSent.manager.submit("f2");
    expect(notSent.manager.operation("f2")?.state).toBe("FAILED");
    expect(notSent.book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
    expect(notSent.reconciler.requests).toEqual([]);
  });

  it("a second concurrent submit of the same operation is refused (no double send)", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { manager, executor } = harness(() => new Promise((resolve) => (release = resolve)));
    manager.plan(split("c1", "1"));
    const first = manager.submit("c1");
    const second = await manager.submit("c1");
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.refusal.code).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    release({ status: "SUBMITTED", transactionHash: TX, transactionId: null });
    expect((await first).ok).toBe(true);
    expect(executor.submitted).toHaveLength(1);
  });

  it("operation ids are single-use", () => {
    const { manager } = harness();
    expect(manager.plan(split("dup", "1")).ok).toBe(true);
    const again = manager.plan(split("dup", "1"));
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.refusal.code).toBe("WALLET_OP_DUPLICATE_ID");
  });
});

describe("an unknown wallet operation triggers reconciliation (acceptance 3)", () => {
  const routes: readonly {
    readonly name: string;
    readonly respond: (s: WalletOperationSubmission) => unknown | Promise<unknown>;
    readonly observation?: unknown;
  }[] = [
    { name: "the executor throws", respond: () => Promise.reject(new Error("socket closed")) },
    { name: "the executor returns an unrecognised status", respond: () => ({ status: "PROBABLY_FINE" }) },
    { name: "the executor returns nothing", respond: () => undefined },
    {
      name: "the executor says SUBMITTED with neither hash nor relayer id",
      respond: () => ({ status: "SUBMITTED", transactionHash: null, transactionId: null }),
    },
    { name: "an observation is unrecognised", respond: () => ({ status: "SUBMITTED", transactionHash: TX, transactionId: null }), observation: { status: "DROPPED" } },
    {
      name: "a CONFIRMED observation has no transaction hash",
      respond: () => ({ status: "SUBMITTED", transactionHash: TX, transactionId: null }),
      observation: { status: "CONFIRMED", transactionId: null },
    },
  ];

  for (const route of routes) {
    it(`${route.name} → UNKNOWN → reconciliation requested → RECONCILING, effects not asserted`, async () => {
      const { book, manager, reconciler } = harness(route.respond);
      manager.plan(split("u", "25"));
      await manager.submit("u");
      if (route.observation !== undefined) manager.observe("u", route.observation);
      expect(manager.operation("u")?.state).toBe("RECONCILING");
      expect(manager.events("u").map((e) => e.newState)).toContain("UNKNOWN");
      expect(reconciler.requests).toEqual([
        expect.objectContaining({ trigger: "WALLET_OPERATION_UNKNOWN", walletOperationId: "u", accountRef: ACCOUNT }),
      ]);
      // The reservation stays held; no YES/NO credited; pUSD not debited.
      expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "25", available: "75" });
      expect(book.line(ACCOUNT, YES)?.actual).toBe("20");
    });
  }

  it("a REDEEM confirmation without the observed credited amount is not assumed: UNKNOWN → reconciliation", async () => {
    const { book, manager, reconciler } = harness();
    manager.plan({ type: "REDEEM", operationId: "rd", accountRef: ACCOUNT, conditionId: CONDITION, resolution: "YES_WIN", yesAmount: "5" });
    await manager.submit("rd");
    manager.observe("rd", { status: "CONFIRMED", transactionHash: TX, transactionId: null });
    expect(manager.operation("rd")?.state).toBe("RECONCILING");
    expect(reconciler.requests).toHaveLength(1);
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("100");
  });

  it("RECONCILING ignores ordinary observations and leaves only on authoritative evidence", async () => {
    const { manager } = harness(() => ({ status: "???" }));
    manager.plan(split("u", "1"));
    await manager.submit("u");
    expect(manager.observe("u", { status: "CONFIRMED", transactionHash: TX, transactionId: null }).ok).toBe(false);
    expect(manager.resolveByReconciliation("u", { state: "CONFIRMED", transactionHash: TX }).ok).toBe(false);
    const notFound = manager.resolveByReconciliation("u", { source: "AUTHORITATIVE_READ", state: "NOT_FOUND" });
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) expect(notFound.refusal.code).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(manager.operation("u")?.state).toBe("RECONCILING");
  });

  it("reconciled FAILED releases the reservation", async () => {
    const { book, manager } = harness(() => ({ status: "???" }));
    manager.plan(split("u", "25"));
    await manager.submit("u");
    expect(manager.resolveByReconciliation("u", { source: "AUTHORITATIVE_READ", state: "FAILED" }).ok).toBe(true);
    expect(manager.operation("u")?.state).toBe("FAILED");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
  });

  it("reconciled CONFIRMED does not re-apply deltas: it releases and blocks the lines until an authoritative read", async () => {
    const { book, manager } = harness(() => ({ status: "???" }));
    manager.plan(split("u", "25"));
    await manager.submit("u");
    const resolved = manager.resolveByReconciliation("u", {
      source: "AUTHORITATIVE_READ",
      state: "CONFIRMED",
      transactionHash: TX,
      transactionId: null,
    });
    expect(resolved.ok && resolved.value).toMatchObject({ state: "CONFIRMED", effectsApplied: false });
    for (const asset of [PUSD, YES, NO]) expect(book.line(ACCOUNT, asset)?.blocked).toBe("AWAITING_OBSERVATION");
    expect(book.reserve({ reservationId: "x", holderRef: "o", accountRef: ACCOUNT, assetId: YES, amount: "1" }).ok).toBe(false);
    expect(book.observeActual({ accountRef: ACCOUNT, assetId: YES, balance: "45" }).ok).toBe(true);
    expect(book.reserve({ reservationId: "y", holderRef: "o", accountRef: ACCOUNT, assetId: YES, amount: "1" }).ok).toBe(true);
  });

  it("reconciled SUBMITTED returns the operation to flight", async () => {
    const { manager } = harness(() => ({ status: "???" }));
    manager.plan(split("u", "1"));
    await manager.submit("u");
    expect(
      manager.resolveByReconciliation("u", { source: "AUTHORITATIVE_READ", state: "SUBMITTED", transactionHash: TX, transactionId: null }).ok,
    ).toBe(true);
    expect(manager.operation("u")?.state).toBe("SUBMITTED");
  });

  it("if the reconciler cannot take the request, the operation stays UNKNOWN (never assumed) until a retry delivers it", async () => {
    const { manager, reconciler, book } = harness(() => ({ status: "???" }));
    reconciler.failing = true;
    manager.plan(split("u", "25"));
    await manager.submit("u");
    expect(manager.operation("u")?.state).toBe("UNKNOWN");
    expect(manager.outstandingReconciliationRequests()).toHaveLength(1);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("25");
    reconciler.failing = false;
    expect(manager.retryReconciliationRequests()).toBe(1);
    expect(manager.operation("u")?.state).toBe("RECONCILING");
    expect(reconciler.requests).toHaveLength(1);
  });

  it("a confirmed operation whose deltas no longer fit the book requests a balance-discrepancy reconciliation", async () => {
    const { book, manager, reconciler } = harness();
    manager.plan(split("s", "25"));
    await manager.submit("s");
    // An authoritative read lowers pUSD below the operation's debit.
    expect(book.observeActual({ accountRef: ACCOUNT, assetId: PUSD, balance: "20" }).ok).toBe(true);
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX, transactionId: null });
    expect(manager.operation("s")).toMatchObject({ state: "CONFIRMED", effectsApplied: false });
    expect(reconciler.requests).toEqual([expect.objectContaining({ trigger: "POSITION_BALANCE_DISCREPANCY" })]);
    expect(book.line(ACCOUNT, YES)?.blocked).toBe("AWAITING_OBSERVATION");
  });
});

describe("approvals", () => {
  it("records a confirmed approval only for a documented venue spender", async () => {
    const { manager, approvals } = harness();
    const bad = manager.plan({
      type: "APPROVE_ERC20",
      operationId: "a0",
      accountRef: ACCOUNT,
      assetId: PUSD,
      spender: "0x000000000000000000000000000000000000dEaD",
      allowance: "100",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.refusal.code).toBe("WALLET_OP_SPENDER_NOT_DOCUMENTED");
    expect(
      manager.plan({ type: "APPROVE_ERC20", operationId: "a1", accountRef: ACCOUNT, assetId: YES, spender: CTF_EXCHANGE, allowance: "1" }).ok,
    ).toBe(false);
    expect(
      manager.plan({ type: "APPROVE_ERC20", operationId: "a2", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" }).ok,
    ).toBe(true);
    await manager.submit("a2");
    manager.observe("a2", { status: "CONFIRMED", transactionHash: TX, transactionId: null });
    // Confirmed on chain, but the CLOB cache has not been synced: not ready (S-D48).
    expect(approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE])).toMatchObject({ ready: false, clobSyncRequired: true });
    approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
    expect(approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE])).toEqual({ ready: true });
  });
});
