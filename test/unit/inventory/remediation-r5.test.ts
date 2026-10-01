/**
 * WP-300 remediation round 5: pins for the verifier's findings WP300-R5-01
 * ("Contradictory evidence during partial reconciliation is discarded,
 * allowing collateral release") and WP300-R5-02 ("Approval readiness remains
 * true after the approval is contested and authoritatively disproved"). Each
 * pin fails against the round-4 candidate (6db057b) and passes after the fix;
 * controls are marked as such.
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
import { ACCOUNT, CONDITION, CTF_EXCHANGE, PUSD, YES, seededBook } from "./helpers.js";

const TX_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const TX_B = "0x00000000000000000000000000000000000000000000000000000000000000b2";

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  request(request: ReconciliationRequest): void {
    this.requests.push(request);
  }
}

function harness() {
  const book = seededBook({ [PUSD]: "100" });
  const reconciler = new Reconciler();
  const approvals = new ApprovalTracker();
  const executor: WalletOperationExecutor = {
    submit: () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }),
  };
  const manager = new WalletOperationManager({ book, approvals, executor, reconciler });
  return { book, reconciler, approvals, manager };
}

const authoritative = (state: string, transactionHash: string | null, transactionId: string | null = null) => ({
  source: "AUTHORITATIVE_READ",
  state,
  transactionHash,
  transactionId,
});

const reserve = (book: ReturnType<typeof seededBook>, amount: string, id: string) =>
  book.reserve({ reservationId: id, holderRef: `holder-${id}`, accountRef: ACCOUNT, assetId: PUSD, amount });

const code = (result: { ok: boolean; refusal?: { code: string } }) => (result.ok ? "ok" : result.refusal?.code);

/**
 * The verifier's steps 1–3: SPLIT 10 submitted as A, MINED(B) moves it to
 * reconciliation, and A is resolved authoritatively as FAILED (B unresolved).
 */
async function partiallyReconciled() {
  const h = harness();
  expect(h.manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }).ok).toBe(
    true,
  );
  await h.manager.submit("s");
  h.manager.observe("s", { status: "MINED", transactionHash: TX_B });
  expect(h.manager.operation("s")?.state).toBe("RECONCILING");
  expect(h.manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)).ok).toBe(true);
  expect(h.manager.operation("s")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_B}`] });
  return h;
}

// ----------------------------------------------------------------- R5-01 --

describe("WP300-R5-01: contradictory evidence during partial reconciliation sets the contested resolution aside", () => {
  it("the verifier's reproduction: CONFIRMED(A) after FAILED(A) was resolved keeps the collateral held when B resolves FAILED", async () => {
    const { book, manager, reconciler } = await partiallyReconciled();
    const before = reconciler.requests.length;

    // Step 4: the contradictory observation is refused as a transition, but not dropped.
    expect(manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null }).ok).toBe(false);
    expect(reconciler.requests).toHaveLength(before + 1);
    expect(reconciler.requests.at(-1)).toMatchObject({
      trigger: "WALLET_OPERATION_UNKNOWN",
      walletOperationId: "s",
      unresolvedTransactions: [`hash:${TX_A}`, `hash:${TX_B}`],
    });
    expect(manager.operation("s")).toMatchObject({
      state: "RECONCILING",
      unresolvedTransactions: [`hash:${TX_A}`, `hash:${TX_B}`],
    });

    // Step 6 (the decisive one): B resolved FAILED does NOT conclude; nothing is released.
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)).ok).toBe(true);
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_A}`] });
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    expect(reserve(book, "100", "all").ok).toBe(false);
    expect(reserve(book, "90", "rest").ok).toBe(true);
    // The contradiction is kept in the operation's history.
    expect(manager.operation("s")?.reopenedTransactions).toEqual([`hash:${TX_A}`]);
  });

  it("the supported recovery path: the authority re-answers the contested transaction by name, then the operation concludes", async () => {
    const { book, manager } = await partiallyReconciled();
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    // Step 5 is now accepted: A's set-aside resolution no longer conflicts with the authority's new answer.
    expect(code(manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A)))).toBe("ok");
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_B}`] });
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)))).toBe("ok");
    // A confirmed: the operation concludes CONFIRMED and the lines await a fresh authoritative read.
    expect(manager.operation("s")?.state).toBe("CONFIRMED");
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("AWAITING_OBSERVATION");
    expect(reserve(book, "1", "one").ok).toBe(false);
  });

  it("the recovery path also accepts the authority confirming its original answer; only then is the collateral released", async () => {
    const { book, manager } = await partiallyReconciled();
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(reserve(book, "100", "all").ok).toBe(true);
  });

  it("an unrecognised observation naming a resolved transaction, or naming none, sets the resolution aside too", async () => {
    for (const observation of [{ status: "DROPPED", transactionHash: TX_A }, { status: "LOST" }]) {
      const { manager, reconciler } = await partiallyReconciled();
      const before = reconciler.requests.length;
      manager.observe("s", observation);
      expect(reconciler.requests).toHaveLength(before + 1);
      expect(manager.operation("s")?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `hash:${TX_B}`]);
      expect(manager.operation("s")?.reopenedTransactions).toEqual([`hash:${TX_A}`]);
    }
  });

  it("control: a repeat of the recorded resolution, or a stale MINED/SUBMITTED report, changes nothing", async () => {
    const { book, manager, reconciler } = await partiallyReconciled();
    const before = reconciler.requests.length;
    for (const observation of [
      { status: "FAILED", transactionHash: TX_A, transactionId: null },
      { status: "MINED", transactionHash: TX_A },
      { status: "SUBMITTED", transactionHash: TX_A, transactionId: null },
    ]) {
      expect(manager.observe("s", observation).ok).toBe(false);
    }
    expect(reconciler.requests).toHaveLength(before);
    expect(manager.operation("s")?.unresolvedTransactions).toEqual([`hash:${TX_B}`]);
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(reserve(book, "100", "all").ok).toBe(true);
    expect(manager.operation("s")?.reopenedTransactions).toEqual([]);
  });

  it("control: without contradicting evidence, the authority still may not re-answer a resolved transaction differently", async () => {
    const { manager } = await partiallyReconciled();
    expect(code(manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A)))).toBe("WALLET_OP_EVIDENCE_CONFLICT");
  });
});

// ----------------------------------------------------------------- R5-02 --

const PLANS = {
  ERC20: { type: "APPROVE_ERC20", operationId: "ap", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" },
  ERC1155: { type: "APPROVE_ERC1155", operationId: "ap", accountRef: ACCOUNT, spender: CTF_EXCHANGE },
} as const;

function readiness(approvals: ApprovalTracker, standard: "ERC20" | "ERC1155"): boolean {
  return standard === "ERC20"
    ? approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE]).ready
    : approvals.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready;
}

function sync(approvals: ApprovalTracker, standard: "ERC20" | "ERC1155"): void {
  if (standard === "ERC20") approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
  else approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });
}

/** Approval A confirmed and synced: ready. */
async function readyApproval(standard: "ERC20" | "ERC1155") {
  const h = harness();
  expect(h.manager.plan(PLANS[standard]).ok).toBe(true);
  expect(readiness(h.approvals, standard)).toBe(false);
  await h.manager.submit("ap");
  h.manager.observe("ap", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
  expect(readiness(h.approvals, standard)).toBe(false);
  sync(h.approvals, standard);
  expect(readiness(h.approvals, standard)).toBe(true);
  return h;
}

describe("WP300-R5-02: a contested approval is not readiness; a disproved one is discarded", () => {
  for (const standard of ["ERC20", "ERC1155"] as const) {
    it(`${standard}: the verifier's reproduction — contested, then authoritatively FAILED, then synced: never ready`, async () => {
      const { manager, approvals, reconciler } = await readyApproval(standard);
      // Step 2: FAILED(A) contests the confirmation; readiness is suspended at once.
      expect(manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null }).ok).toBe(false);
      expect(manager.operation("ap")?.quarantined).toBe(true);
      expect(readiness(approvals, standard)).toBe(false);
      sync(approvals, standard);
      expect(readiness(approvals, standard)).toBe(false);
      expect(approvals.approvalStatus("ap")).toBe("SUSPENDED");
      expect(reconciler.requests.at(-1)?.trigger).toBe("POSITION_BALANCE_DISCREPANCY");
      // Step 3: the authority says FAILED; the approval is discarded.
      expect(manager.resolveByReconciliation("ap", authoritative("FAILED", TX_A)).ok).toBe(true);
      expect(manager.operation("ap")?.quarantined).toBe(false);
      expect(readiness(approvals, standard)).toBe(false);
      expect(approvals.approvalStatus("ap")).toBe("NONE");
      // Step 4: another sync does not bring back a disproved approval.
      sync(approvals, standard);
      expect(readiness(approvals, standard)).toBe(false);
    });

    it(`${standard}: an authoritative CONFIRMED restores the approval, but readiness needs a sync recorded after it`, async () => {
      const { manager, approvals } = await readyApproval(standard);
      manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
      expect(readiness(approvals, standard)).toBe(false);
      expect(manager.resolveByReconciliation("ap", authoritative("CONFIRMED", TX_A)).ok).toBe(true);
      expect(approvals.approvalStatus("ap")).toBe("ACTIVE");
      // The sync recorded before the contest does not count.
      expect(readiness(approvals, standard)).toBe(false);
      sync(approvals, standard);
      expect(readiness(approvals, standard)).toBe(true);
      // Evidence contradicting the authoritative answer suspends it again.
      manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
      expect(approvals.approvalStatus("ap")).toBe("SUSPENDED");
      expect(readiness(approvals, standard)).toBe(false);
    });
  }

  it("a confirmed approval contested by an unknown transaction that the authority answers FAILED is discarded (fail-closed)", async () => {
    const { manager, approvals } = await readyApproval("ERC20");
    manager.observe("ap", { status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    expect(readiness(approvals, "ERC20")).toBe(false);
    expect(manager.resolveByReconciliation("ap", authoritative("FAILED", TX_B)).ok).toBe(true);
    expect(approvals.approvalStatus("ap")).toBe("NONE");
    sync(approvals, "ERC20");
    expect(readiness(approvals, "ERC20")).toBe(false);
  });

  it("a FAILED approval whose contest the authority answers CONFIRMED is recorded, and needs a sync after it", async () => {
    const { manager, approvals } = harness();
    manager.plan(PLANS.ERC20);
    await manager.submit("ap");
    manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
    sync(approvals, "ERC20");
    expect(readiness(approvals, "ERC20")).toBe(false);
    manager.observe("ap", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(manager.operation("ap")?.quarantined).toBe(true);
    expect(manager.resolveByReconciliation("ap", authoritative("CONFIRMED", TX_A)).ok).toBe(true);
    expect(readiness(approvals, "ERC20")).toBe(false);
    sync(approvals, "ERC20");
    expect(readiness(approvals, "ERC20")).toBe(true);
    expect(approvals.approvalStatus("ap")).toBe("ACTIVE");
  });

  it("control: another operation's valid approval of the same spender keeps readiness while one is suspended", async () => {
    const { manager, approvals } = await readyApproval("ERC20");
    approvals.recordConfirmedApproval({
      accountRef: ACCOUNT,
      standard: "ERC20",
      assetId: PUSD,
      spender: CTF_EXCHANGE,
      walletOperationId: "other",
    });
    sync(approvals, "ERC20");
    manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
    expect(readiness(approvals, "ERC20")).toBe(true);
    expect(approvals.approvalStatus("ap")).toBe("SUSPENDED");
    expect(approvals.discardApproval("other")).toBe(true);
    expect(readiness(approvals, "ERC20")).toBe(false);
  });
});
