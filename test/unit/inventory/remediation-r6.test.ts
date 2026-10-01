/**
 * WP-300 remediation round 6: pins for the verifier's findings WP300-R6-01
 * ("A newly learned relayer ID bypasses contradictory-evidence handling and
 * releases collateral") and WP300-R6-02 ("A stale relayer-ID resolution
 * restores an authoritatively disproved approval"), and for the defect class
 * behind rounds 3-6: evidence keyed by one identifier missed contradicting or
 * superseding evidence held under an associated identifier. Each pin fails
 * against the round-5 candidate (00bf13d) and passes after the fix; controls
 * are marked as such. The seeded interleaving property over the whole class is
 * `wallet-evidence.property.test.ts`.
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

// Valid 32-byte transaction hashes (the verifier also reproduced R6-01 with these).
const TX_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const TX_B = "0x00000000000000000000000000000000000000000000000000000000000000b2";
const ID_R = "sanitized-relayer-id-r";
const ID_S = "sanitized-relayer-id-s";
const ID_T = "sanitized-relayer-id-t";

/**
 * WP300-R7-X3: a reconciliation answer names the request it answers. The
 * answers in this suite were written as CURRENT answers, so each is bound to
 * the latest request this test's reconciler received (what a reconciler that
 * re-reads on every request sends). Stale and unbound answers are pinned in
 * `remediation-r7.test.ts` and the property suite.
 */
let latestRequestId: string | undefined;

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  constructor() {
    latestRequestId = undefined;
  }
  request(request: ReconciliationRequest): void {
    this.requests.push(request);
    latestRequestId = request.requestId;
  }
}

function harness(submitted: { readonly transactionHash: string; readonly transactionId: string | null }) {
  const book = seededBook({ [PUSD]: "100" });
  const reconciler = new Reconciler();
  const approvals = new ApprovalTracker();
  const executor: WalletOperationExecutor = { submit: () => Promise.resolve({ status: "SUBMITTED", ...submitted }) };
  const manager = new WalletOperationManager({ book, approvals, executor, reconciler });
  return { book, reconciler, approvals, manager };
}

const authoritative = (state: string, transactionHash: string | null, transactionId: string | null = null) => ({
  source: "AUTHORITATIVE_READ",
  state,
  transactionHash,
  transactionId,
  requestId: latestRequestId,
});

const reserve = (book: ReturnType<typeof seededBook>, amount: string, id: string) =>
  book.reserve({ reservationId: id, holderRef: `holder-${id}`, accountRef: ACCOUNT, assetId: PUSD, amount });

const code = (result: { ok: boolean; refusal?: { code: string } }) => (result.ok ? "ok" : result.refusal?.code);

/** The verifier's steps 1-3: SPLIT 10 under A, MINED(B) → reconciliation, A resolved FAILED. */
async function splitWithAResolvedFailed() {
  const h = harness({ transactionHash: TX_A, transactionId: null });
  expect(h.manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }).ok).toBe(
    true,
  );
  await h.manager.submit("s");
  h.manager.observe("s", { status: "MINED", transactionHash: TX_B });
  expect(h.manager.operation("s")?.state).toBe("RECONCILING");
  expect(code(h.manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)))).toBe("ok");
  return h;
}

/** Nothing of the SPLIT's 10 pUSD is spendable: the reservation is held. */
function expectHeld(book: ReturnType<typeof seededBook>): void {
  expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
  expect(reserve(book, "100", "all").ok).toBe(false);
}

// ----------------------------------------------------------------- R6-01 --

describe("WP300-R6-01: an observation cannot evade contradiction handling by naming another identifier", () => {
  it("the verifier's reproduction (without step 5): CONFIRMED(A) with a new relayer id, then B resolved FAILED, releases nothing", async () => {
    const { book, manager, reconciler } = await splitWithAResolvedFailed();
    const before = reconciler.requests.length;
    expect(manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: ID_R }).ok).toBe(false);
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)))).toBe("ok");
    // The decisive step: the contradiction under A and the new relayer id keep the collateral held.
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expectHeld(book);
    // How: A's resolution was set aside and the new relayer id must be resolved too.
    expect(manager.operation("s")).toMatchObject({
      unresolvedTransactions: [`hash:${TX_A}`, `id:${ID_R}`],
      reopenedTransactions: [`hash:${TX_A}`],
      transactionIds: [ID_R],
    });
    expect(reconciler.requests.length).toBe(before + 1);
    expect(reconciler.requests[before]).toMatchObject({
      trigger: "WALLET_OPERATION_UNKNOWN",
      unresolvedTransactions: [`hash:${TX_A}`, `hash:${TX_B}`, `id:${ID_R}`],
    });
  });

  it("the verifier's reproduction (with step 5): the authority's fresh CONFIRMED(A) is accepted, and still nothing is released while the relayer id is unresolved", async () => {
    const { book, manager } = await splitWithAResolvedFailed();
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: ID_R });
    // Step 5: A's resolution was set aside, so the authority may answer it again (it was refused on 00bf13d).
    expect(code(manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A)))).toBe("ok");
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)))).toBe("ok");
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`id:${ID_R}`] });
    expectHeld(book);
    // Recovery: the relayer id answered by name; A confirmed, so the lines await a fresh authoritative read.
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", null, ID_R)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("CONFIRMED");
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("AWAITING_OBSERVATION");
    expect(reserve(book, "1", "one").ok).toBe(false);
  });

  it("an unrecognised observation naming A and a new relayer id reopens A and requires the id", async () => {
    const { book, manager } = await splitWithAResolvedFailed();
    manager.observe("s", { status: "DROPPED", transactionHash: TX_A, transactionId: ID_R });
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expectHeld(book);
    expect(manager.operation("s")?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `id:${ID_R}`]);
    // Recovery: one answer naming both identifiers covers them; then the operation concludes FAILED.
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_A, ID_R)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(reserve(book, "100", "all-2").ok).toBe(true);
  });

  it("a relayer id first named during reconciliation is resolved by name like every other identifier (no singleton exclusion)", async () => {
    const { book, manager, reconciler } = await splitWithAResolvedFailed();
    const before = reconciler.requests.length;
    // A stale MINED(B) that also names a relayer id nobody had named.
    manager.observe("s", { status: "MINED", transactionHash: TX_B, transactionId: ID_R });
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expectHeld(book);
    expect(manager.operation("s")?.unresolvedTransactions).toEqual([`id:${ID_R}`]);
    expect(reconciler.requests.at(before)?.unresolvedTransactions).toEqual([`hash:${TX_B}`, `id:${ID_R}`]);
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", null, ID_R)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(reserve(book, "100", "all-3").ok).toBe(true);
  });

  it("control: the same confirmation without a new relayer id reopens A and prevents release", async () => {
    const { book, manager } = await splitWithAResolvedFailed();
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)))).toBe("ok");
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_A}`] });
    expectHeld(book);
  });
});

// ----------------------------------------------------------------- R6-02 --

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

/**
 * The verifier's steps 1-4: approval submitted as (A, R), MINED(B, S) sends it
 * to reconciliation, (A, R) is answered CONFIRMED and (B, S) FAILED, a sync
 * is recorded: ready.
 */
async function readyAfterReconciliation(standard: "ERC20" | "ERC1155") {
  const h = harness({ transactionHash: TX_A, transactionId: ID_R });
  expect(h.manager.plan(PLANS[standard]).ok).toBe(true);
  await h.manager.submit("ap");
  h.manager.observe("ap", { status: "MINED", transactionHash: TX_B, transactionId: ID_S });
  expect(h.manager.operation("ap")?.state).toBe("RECONCILING");
  expect(code(h.manager.resolveByReconciliation("ap", authoritative("CONFIRMED", TX_A, ID_R)))).toBe("ok");
  expect(code(h.manager.resolveByReconciliation("ap", authoritative("FAILED", TX_B, ID_S)))).toBe("ok");
  expect(h.manager.operation("ap")?.state).toBe("CONFIRMED");
  sync(h.approvals, standard);
  expect(readiness(h.approvals, standard)).toBe(true);
  return h;
}

describe("WP300-R6-02: an authoritative FAILED answer covers every associated identifier; no stale CONFIRMED survives", () => {
  for (const standard of ["ERC20", "ERC1155"] as const) {
    it(`${standard}: the verifier's reproduction — A and R answered FAILED in one answer, then synced: never ready`, async () => {
      const { manager, approvals } = await readyAfterReconciliation(standard);
      // Step 5: FAILED(A) contests the approval.
      expect(manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null }).ok).toBe(false);
      expect(readiness(approvals, standard)).toBe(false);
      // Step 6: the authority answers A and R FAILED together; step 7: another sync.
      expect(code(manager.resolveByReconciliation("ap", authoritative("FAILED", TX_A, ID_R)))).toBe("ok");
      sync(approvals, standard);
      expect(readiness(approvals, standard)).toBe(false);
      expect(approvals.approvalStatus("ap")).toBe("NONE");
      expect(manager.operation("ap")).toMatchObject({ quarantined: false, unresolvedTransactions: [] });
    });

    it(`${standard}: the hash-only answer leaves the associated relayer id unresolved; the approval stays suspended`, async () => {
      const { manager, approvals, reconciler } = await readyAfterReconciliation(standard);
      manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
      expect(code(manager.resolveByReconciliation("ap", authoritative("FAILED", TX_A)))).toBe("ok");
      sync(approvals, standard);
      // The decisive step: the hash-only answer does not restore the approval.
      expect(readiness(approvals, standard)).toBe(false);
      expect(approvals.approvalStatus("ap")).toBe("SUSPENDED");
      // How: the FAILED fact set aside the CONFIRMED evidence under BOTH confirmed identifiers, A and R.
      expect(reconciler.requests.at(-1)?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `id:${ID_R}`]);
      expect(manager.operation("ap")).toMatchObject({ quarantined: true, unresolvedTransactions: [`id:${ID_R}`] });
      // Recovery: the relayer id answered too. Nothing confirmed remains, so the approval is discarded.
      expect(code(manager.resolveByReconciliation("ap", authoritative("FAILED", null, ID_R)))).toBe("ok");
      sync(approvals, standard);
      expect(readiness(approvals, standard)).toBe(false);
      expect(approvals.approvalStatus("ap")).toBe("NONE");
    });

    it(`${standard}: control — the authority re-confirming A and R restores the approval, which needs a sync after it`, async () => {
      const { manager, approvals } = await readyAfterReconciliation(standard);
      manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
      expect(code(manager.resolveByReconciliation("ap", authoritative("CONFIRMED", TX_A, ID_R)))).toBe("ok");
      expect(approvals.approvalStatus("ap")).toBe("ACTIVE");
      expect(readiness(approvals, standard)).toBe(false);
      sync(approvals, standard);
      expect(readiness(approvals, standard)).toBe(true);
    });
  }

  it("before the conclusion: FAILED(A) naming a new relayer id after A was answered CONFIRMED is not lost; no approval is recorded", async () => {
    const { manager, approvals } = harness({ transactionHash: TX_A, transactionId: null });
    expect(manager.plan(PLANS.ERC20).ok).toBe(true);
    await manager.submit("ap");
    manager.observe("ap", { status: "MINED", transactionHash: TX_B });
    expect(code(manager.resolveByReconciliation("ap", authoritative("CONFIRMED", TX_A)))).toBe("ok");
    manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: ID_T });
    expect(code(manager.resolveByReconciliation("ap", authoritative("FAILED", TX_B)))).toBe("ok");
    sync(approvals, "ERC20");
    // The decisive step: no conclusion, no approval, never ready.
    expect(readiness(approvals, "ERC20")).toBe(false);
    expect(manager.operation("ap")).toMatchObject({
      state: "RECONCILING",
      unresolvedTransactions: [`hash:${TX_A}`, `id:${ID_T}`],
    });
    expect(approvals.approvalStatus("ap")).toBe("NONE");
    // Recovery: both answered FAILED → the operation concludes FAILED; no approval.
    expect(code(manager.resolveByReconciliation("ap", authoritative("FAILED", TX_A, ID_T)))).toBe("ok");
    expect(manager.operation("ap")?.state).toBe("FAILED");
    sync(approvals, "ERC20");
    expect(readiness(approvals, "ERC20")).toBe(false);
  });
});

// ------------------------------------------------------------- the class --

describe("WP300-R6 class guards: every identifier of the set is answered for", () => {
  it("with one identity, an answer must name a member of the set; naming only an unseen relayer id concludes nothing", async () => {
    const h = harness({ transactionHash: TX_A, transactionId: null });
    h.manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" });
    await h.manager.submit("s");
    h.manager.observe("s", { status: "DROPPED" });
    expect(h.manager.operation("s")?.state).toBe("RECONCILING");
    expect(code(h.manager.resolveByReconciliation("s", authoritative("FAILED", null, ID_R)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expectHeld(h.book);
    // Amended in r7 (WP300-R7-X1): the refused answer is weighed, not thrown away,
    // so the relayer id it named joined the set (it was `transactionIds: []`
    // before r7) and, like every member, must be answered by name.
    expect(h.manager.operation("s")).toMatchObject({
      state: "RECONCILING",
      transactionIds: [ID_R],
      unresolvedTransactions: [`hash:${TX_A}`, `id:${ID_R}`],
    });
    // Control: naming the operation's transaction and the relayer id concludes it.
    expect(code(h.manager.resolveByReconciliation("s", authoritative("FAILED", TX_A, ID_R)))).toBe("ok");
    expect(h.manager.operation("s")?.state).toBe("FAILED");
  });

  it("a late executor answer naming a first relayer id, once the whole set must be answered, asks the reconciler for it", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const book = seededBook({ [PUSD]: "100" });
    const reconciler = new Reconciler();
    const executor: WalletOperationExecutor = { submit: () => new Promise((resolve) => (answer = resolve)) };
    const manager = new WalletOperationManager({ book, approvals: new ApprovalTracker(), executor, reconciler });
    manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" });
    const submitting = manager.submit("s");
    manager.observe("s", { status: "DROPPED" });
    // Evidence naming A while under reconciliation: the whole set is answered by name from now on.
    manager.observe("s", { status: "MINED", transactionHash: TX_A });
    expect(manager.operation("s")?.unresolvedTransactions).toEqual([`hash:${TX_A}`]);
    const before = reconciler.requests.length;
    answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R });
    await submitting;
    expect(manager.operation("s")?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `id:${ID_R}`]);
    expect(reconciler.requests).toHaveLength(before + 1);
    expect(reconciler.requests.at(-1)?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `id:${ID_R}`]);
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)))).toBe("ok");
    expectHeld(book);
    expect(code(manager.resolveByReconciliation("s", authoritative("FAILED", null, ID_R)))).toBe("ok");
    expect(manager.operation("s")?.state).toBe("FAILED");
  });
});
