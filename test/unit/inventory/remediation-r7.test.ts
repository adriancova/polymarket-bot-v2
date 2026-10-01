/**
 * WP-300 remediation round 7: pins for the reconciled findings
 * - WP300-R7-X3 (HIGH): stale or delayed reconciliation answers were accepted;
 * - WP300-R7-X1 (HIGH): refused authoritative reconciliation evidence was
 *   thrown away instead of being weighed against the identity set;
 * - WP300-R7-X2 (MEDIUM): an authoritative FAILED for a CONFIRMED approval that
 *   was not quarantined was discarded, so readiness stayed true;
 * - WP300-R7-X4 (LOW): the pairing of hashes and relayer ids that is still
 *   assumed (simple mode, in flight) is now stated, and pinned here.
 * Each pin fails against the round-6 candidate (0d001d6) and passes after the
 * fix; controls are marked as such. The seeded interleaving property with
 * separate request, read and delivery events is
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
import { ACCOUNT, CONDITION, CTF_EXCHANGE, NO, PUSD, USDC_E, YES, seededBook } from "./helpers.js";

// Valid 32-byte transaction hashes (the verifiers' probes used these shapes).
const TX_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TX_C = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const ID_R = "sanitized-relayer-id-r";

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  failing = false;
  onRequest: ((request: ReconciliationRequest) => void) | undefined;
  request(request: ReconciliationRequest): void {
    if (this.failing) throw new Error("reconciler unavailable");
    this.requests.push(request);
    this.onRequest?.(request);
  }
  /** The id of the n-th request received (1-based), as a job reading for it would echo it. */
  id(n: number): string {
    const request = this.requests[n - 1];
    if (request === undefined) throw new Error(`no request #${String(n)}`);
    return request.requestId;
  }
  latest(): string {
    return this.id(this.requests.length);
  }
}

function harness(submit: () => Promise<unknown> = () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null })) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const reconciler = new Reconciler();
  const approvals = new ApprovalTracker();
  const executor: WalletOperationExecutor = { submit };
  const manager = new WalletOperationManager({ book, approvals, executor, reconciler });
  return { book, reconciler, approvals, manager };
}

type Harness = ReturnType<typeof harness>;

/** An authoritative read reported as an answer; `requestId` is the request it was read for (none: unbound). */
const auth = (state: string, transactionHash: string | null, transactionId: string | null = null, requestId?: string) => ({
  source: "AUTHORITATIVE_READ",
  state,
  transactionHash,
  transactionId,
  ...(requestId === undefined ? {} : { requestId }),
});

const code = (result: { ok: boolean; refusal?: { code: string } }) => (result.ok ? "ok" : result.refusal?.code);

// ------------------------------------------------------- value operations --

interface ValueOp {
  readonly type: string;
  readonly plan: Readonly<Record<string, unknown>>;
  /** The asset the operation reserves, how much of it, and the account's whole balance of it. */
  readonly asset: string;
  readonly amount: string;
  readonly balance: string;
}

const VALUE_OPS: readonly ValueOp[] = [
  { type: "SPLIT", plan: { type: "SPLIT", conditionId: CONDITION, amount: "10" }, asset: PUSD, amount: "10", balance: "100" },
  { type: "MERGE", plan: { type: "MERGE", conditionId: CONDITION, amount: "5" }, asset: YES, amount: "5", balance: "20" },
  {
    type: "REDEEM",
    plan: { type: "REDEEM", conditionId: CONDITION, resolution: "YES_WIN", yesAmount: "5" },
    asset: YES,
    amount: "5",
    balance: "20",
  },
  { type: "WRAP_COLLATERAL", plan: { type: "WRAP_COLLATERAL", amount: "10" }, asset: USDC_E, amount: "10", balance: "50" },
  { type: "UNWRAP_COLLATERAL", plan: { type: "UNWRAP_COLLATERAL", amount: "10" }, asset: PUSD, amount: "10", balance: "100" },
];

async function submitted(op: ValueOp, submit?: () => Promise<unknown>): Promise<Harness> {
  const h = harness(submit);
  const planned = h.manager.plan({ ...op.plan, operationId: "op", accountRef: ACCOUNT });
  expect(planned.ok).toBe(true);
  await h.manager.submit("op");
  return h;
}

/** Whether the whole balance of the operation's reserved asset can be reserved (the collateral was released). */
function wholeBalanceReservable(h: Harness, op: ValueOp, id = "all"): boolean {
  const result = h.book.reserve({ reservationId: id, holderRef: `holder-${id}`, accountRef: ACCOUNT, assetId: op.asset, amount: op.balance });
  if (result.ok) h.book.release({ reservationId: id });
  return result.ok;
}

function expectHeld(h: Harness, op: ValueOp): void {
  expect(h.book.line(ACCOUNT, op.asset)?.reserved).toBe(op.amount);
  expect(wholeBalanceReservable(h, op)).toBe(false);
}

const SPLIT = VALUE_OPS[0] as ValueOp;

// ------------------------------------------------------------------ R7-X3 --

describe("WP300-R7-X3: an answer is bound to the request it answers; a superseded answer is refused before it changes standing evidence", () => {
  /** The verifiers' steps 1-3: SPLIT 10 under A; MINED(B) and MINED(C) raise requests 1 and 2; job 1's FAILED(A) is accepted. */
  async function astraSetup(): Promise<Harness> {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    h.manager.observe("op", { status: "MINED", transactionHash: TX_C });
    expect(h.reconciler.requests).toHaveLength(2);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.id(1))))).toBe("ok");
    return h;
  }

  it("the verifiers' collateral reproduction: job 2's FAILED(A), read before CONFIRMED(A) reopened A, is refused; nothing is released", async () => {
    const h = await astraSetup();
    // Step 4: observe CONFIRMED(A) reopens A and raises request 3.
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.reconciler.requests).toHaveLength(3);
    expect(h.reconciler.requests[2]?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `hash:${TX_B}`, `hash:${TX_C}`]);
    // Step 5 (the decisive one): job 2's FAILED(A), read for request 2, before the observation.
    const stale = h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.id(2)));
    expect(code(stale)).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    // Step 6: B and C resolved FAILED for the latest request: nothing concludes, nothing is released.
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_C, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_A}`] });
    expectHeld(h, SPLIT);
    // Step 7: job 3's CONFIRMED(A) was read for request 3; the delayed FAILED(A),
    // weighed after request 3 was issued, may be newer than that read: superseded too.
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.id(3))))).toBe(
      "WALLET_OP_EVIDENCE_SUPERSEDED",
    );
    expectHeld(h, SPLIT);
    // Recovery: a read for the latest request concludes; the lines await a fresh authoritative read.
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("CONFIRMED");
    expect(h.book.line(ACCOUNT, PUSD)?.blocked).toBe("AWAITING_OBSERVATION");
    expect(wholeBalanceReservable(h, SPLIT)).toBe(false);
  });

  it("control: the fresh CONFIRMED(A) first; the stale FAILED(A) is refused and contests it, so A is read again", async () => {
    const h = await astraSetup();
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.id(3))))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.id(2))))).toBe(
      "WALLET_OP_EVIDENCE_SUPERSEDED",
    );
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `hash:${TX_B}`, `hash:${TX_C}`]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_C, null, h.reconciler.latest())))).toBe("ok");
    expectHeld(h, SPLIT);
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("CONFIRMED");
    expect(wholeBalanceReservable(h, SPLIT)).toBe(false);
  });

  for (const standard of ["ERC20", "ERC1155"] as const) {
    it(`${standard}: the verifiers' approval reproduction — job 2's stale CONFIRMED(A) is refused; never ready`, async () => {
      const h = harness();
      const plan =
        standard === "ERC20"
          ? { type: "APPROVE_ERC20", operationId: "ap", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" }
          : { type: "APPROVE_ERC1155", operationId: "ap", accountRef: ACCOUNT, spender: CTF_EXCHANGE };
      const ready = (): boolean =>
        standard === "ERC20"
          ? h.approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE]).ready
          : h.approvals.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready;
      const sync = (): void =>
        standard === "ERC20"
          ? h.approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" })
          : h.approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });
      expect(h.manager.plan(plan).ok).toBe(true);
      await h.manager.submit("ap");
      h.manager.observe("ap", { status: "MINED", transactionHash: TX_B });
      h.manager.observe("ap", { status: "MINED", transactionHash: TX_C });
      expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.id(1))))).toBe("ok");
      h.manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
      // The decisive step: job 2's CONFIRMED(A), read for request 2, before the FAILED(A) observation.
      expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.id(2))))).toBe(
        "WALLET_OP_EVIDENCE_SUPERSEDED",
      );
      expect(code(h.manager.resolveByReconciliation("ap", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
      expect(code(h.manager.resolveByReconciliation("ap", auth("FAILED", TX_C, null, h.reconciler.latest())))).toBe("ok");
      sync();
      expect(ready()).toBe(false);
      expect(h.manager.operation("ap")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_A}`] });
      expect(h.approvals.approvalStatus("ap")).toBe("NONE");
      // Job 3's FAILED(A) (read for request 3) is superseded by the delayed CONFIRMED weighed after it was issued.
      expect(code(h.manager.resolveByReconciliation("ap", auth("FAILED", TX_A, null, h.reconciler.id(3))))).toBe(
        "WALLET_OP_EVIDENCE_SUPERSEDED",
      );
      expect(code(h.manager.resolveByReconciliation("ap", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      expect(h.manager.operation("ap")?.state).toBe("FAILED");
      sync();
      expect(ready()).toBe(false);
      expect(h.approvals.approvalStatus("ap")).toBe("NONE");
    });
  }

  it("issue, read and delivery are separate events: a read made before contrary evidence is refused when delivered after it", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "DROPPED" });
    expect(h.reconciler.requests).toHaveLength(1);
    // Request 1 is issued; the reconciler reads FAILED(A) for it.
    const read = auth("FAILED", TX_A, null, h.reconciler.id(1));
    // Contrary evidence arrives before the answer is delivered (request 2 is issued).
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.reconciler.requests).toHaveLength(2);
    // Delivery of the read made for request 1: refused before it changes anything.
    expect(code(h.manager.resolveByReconciliation("op", read))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expectHeld(h, SPLIT);
    // A read for request 2 (issued after the evidence) is accepted.
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.id(2))))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });

  it("control: the same read delivered BEFORE the contrary evidence is accepted, and the evidence then contests it", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.id(1))))).toBe("ok");
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.manager.operation("op")?.reopenedTransactions).toEqual([`hash:${TX_A}`]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
    expectHeld(h, SPLIT);
  });

  it("control: agreeing evidence does not supersede a read (a CONFIRMED fact does not supersede a CONFIRMED answer)", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    const read = auth("CONFIRMED", TX_A, null, h.reconciler.id(1));
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.reconciler.requests).toHaveLength(2);
    expect(code(h.manager.resolveByReconciliation("op", read))).toBe("ok");
    // ...but a FAILED read of A made for request 1 would have been superseded.
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([`hash:${TX_B}`]);
  });

  it("an answer naming no request is current only while nothing has been weighed; one naming an unknown request is refused", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    // Nothing weighed yet: an unbound answer is accepted.
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B)))).toBe("ok");
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    // After contrary evidence, an unbound FAILED(A) is taken as read before it.
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, "not-a-request-of-this-operation")))).toBe(
      "WALLET_OP_EVIDENCE_REQUIRED",
    );
    expect(code(h.manager.resolveByReconciliation("op", { ...auth("FAILED", TX_A), requestId: 7 }))).toBe(
      "WALLET_OP_EVIDENCE_REQUIRED",
    );
    expectHeld(h, SPLIT);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });

  it("an answer read for a request issued before the operation re-entered reconciliation is superseded", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "DROPPED" });
    // Reconciliation says "still in flight": the operation returns to MINED.
    expect(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, h.reconciler.id(1))))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("MINED");
    // Conflicting evidence in flight sends it back to reconciliation (request 2).
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.id(1))))).toBe(
      "WALLET_OP_EVIDENCE_SUPERSEDED",
    );
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.id(1))))).toBe(
      "WALLET_OP_EVIDENCE_SUPERSEDED",
    );
    expectHeld(h, SPLIT);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });

  for (const late of [{ status: "NOT_SENT" }, { status: "???" }] as const) {
    it(`a late ${late.status} from the executor (a contradiction outside flight) supersedes reads made for earlier requests`, async () => {
      let answer: (value: unknown) => void = () => undefined;
      const h = harness(() => new Promise((resolve) => (answer = resolve)));
      expect(h.manager.plan({ ...SPLIT.plan, operationId: "op", accountRef: ACCOUNT }).ok).toBe(true);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", { status: "DROPPED" });
      expect(h.reconciler.requests).toHaveLength(1);
      // A job reads CONFIRMED(A) for request 1; the executor then answers, contradicting the evidence.
      const read = auth("CONFIRMED", TX_A, null, h.reconciler.id(1));
      answer(late);
      await submitting;
      expect(h.manager.operation("op")?.state).toBe("RECONCILING");
      expect(h.reconciler.requests).toHaveLength(2);
      expect(code(h.manager.resolveByReconciliation("op", read))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, SPLIT);
      // The refused read was weighed: A, named for the first time, must be read again. Control: a read for the latest request is accepted.
      expect(h.reconciler.requests).toHaveLength(3);
      expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      expect(h.manager.operation("op")?.state).toBe("CONFIRMED");
    });
  }

  it("a queued request that a newer request supersedes is not delivered late", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    h.reconciler.failing = true;
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    h.manager.observe("op", { status: "FAILED", transactionHash: TX_B, transactionId: null });
    const queued = h.manager.outstandingReconciliationRequests();
    expect(queued).toHaveLength(2);
    h.reconciler.failing = false;
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    // Only the newest is delivered, so the latest request received is the newest issued.
    expect(h.reconciler.requests.at(-1)?.requestId).toBe(queued[1]?.requestId);
    expect(h.manager.outstandingReconciliationRequests()).toEqual([]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });

  it("a synchronous reconciler that keeps answering a superseded request cannot drive recursion: nested requests are queued", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    const first = h.reconciler.id(1);
    let answers = 0;
    h.reconciler.onRequest = () => {
      answers += 1;
      h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, first));
    };
    // A doubt: CONFIRMED reads made for request 1 are superseded. Its request is
    // answered (synchronously, stale); the weighed stale answer's own request is queued.
    h.manager.observe("op", { status: "FAILED", transactionHash: TX_B, transactionId: null });
    expect(answers).toBe(1);
    expect(h.manager.outstandingReconciliationRequests()).toHaveLength(1);
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expectHeld(h, SPLIT);
  });
});

// ------------------------------------------------------------------ R7-X1 --

describe("WP300-R7-X1: refused reconciliation evidence is weighed like an observation, never thrown away", () => {
  for (const op of VALUE_OPS) {
    describe(op.type, () => {
      for (const route of ["authoritative", "observation (control)"] as const) {
        const deliver = (h: Harness, evidence: { state: string; hash: string | null; id: string | null }) =>
          route === "authoritative"
            ? h.manager.resolveByReconciliation("op", auth(evidence.state, evidence.hash, evidence.id, h.reconciler.latest()))
            : h.manager.observe("op", { status: evidence.state, transactionHash: evidence.hash, transactionId: evidence.id });

        it(`(a) a new hash under the member relayer id, via the ${route}: the next answer releases nothing`, async () => {
          const h = await submitted(op, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R }));
          h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A, transactionId: ID_R });
          expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([]);
          const result = deliver(h, { state: "CONFIRMED", hash: TX_C, id: ID_R });
          if (route === "authoritative") expect(code(result)).toBe("WALLET_OP_EVIDENCE_CONFLICT");
          expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `hash:${TX_C}`, `id:${ID_R}`]);
          expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
          expect(h.manager.operation("op")?.state).toBe("RECONCILING");
          expectHeld(h, op);
        });

        it(`(b) a contradiction of the authority's recorded answer, via the ${route}: the answer is set aside`, async () => {
          const h = await submitted(op);
          h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
          expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
          const result = deliver(h, { state: "CONFIRMED", hash: TX_A, id: null });
          if (route === "authoritative") expect(code(result)).toBe("WALLET_OP_EVIDENCE_CONFLICT");
          expect(h.manager.operation("op")).toMatchObject({
            unresolvedTransactions: [`hash:${TX_A}`, `hash:${TX_B}`],
            reopenedTransactions: [`hash:${TX_A}`],
          });
          expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
          expect(h.manager.operation("op")?.state).toBe("RECONCILING");
          expectHeld(h, op);
        });

        it(`(c) evidence while the executor is pending, via the ${route}: it is weighed, and every member is required`, async () => {
          let answer: (value: unknown) => void = () => undefined;
          const h = await (async () => {
            const made = harness(() => new Promise((resolve) => (answer = resolve)));
            expect(made.manager.plan({ ...op.plan, operationId: "op", accountRef: ACCOUNT }).ok).toBe(true);
            return made;
          })();
          const submitting = h.manager.submit("op");
          h.manager.observe("op", { status: "DROPPED" });
          expect(h.manager.operation("op")?.state).toBe("RECONCILING");
          const result = deliver(h, { state: "CONFIRMED", hash: TX_A, id: null });
          if (route === "authoritative") expect(code(result)).toBe("WALLET_OP_EVIDENCE_REQUIRED");
          answer({ status: "SUBMITTED", transactionHash: null, transactionId: ID_R });
          await submitting;
          expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `id:${ID_R}`]);
          expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
          expect(h.manager.operation("op")?.state).toBe("RECONCILING");
          expectHeld(h, op);
        });

        it(`(d) a contradiction after a terminal state, via the ${route}: the lines are quarantined`, async () => {
          const h = await submitted(op);
          h.manager.observe("op", { status: "FAILED", transactionHash: TX_A, transactionId: null });
          expect(h.manager.operation("op")?.state).toBe("FAILED");
          const result =
            route === "authoritative"
              ? h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A))
              : h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
          if (route === "authoritative") expect(code(result)).toBe("WALLET_OP_ILLEGAL_TRANSITION");
          expect(h.manager.operation("op")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_A}`] });
          expect(h.book.line(ACCOUNT, op.asset)?.blocked).toBe("QUARANTINED");
          expect(wholeBalanceReservable(h, op)).toBe(false);
          expect(h.reconciler.requests.at(-1)?.trigger).toBe("POSITION_BALANCE_DISCREPANCY");
        });
      }
    });
  }

  it("(d) after the simple-mode conclusion, the authority's CONFIRMED(C, R) naming a new hash is weighed: quarantined", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R }));
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A, transactionId: ID_R });
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_C, ID_R)))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(h.manager.operation("op")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_C}`, `id:${ID_R}`] });
    expect(wholeBalanceReservable(h, SPLIT)).toBe(false);
  });

  it("inconclusive or non-authoritative evidence is weighed too: NOT_FOUND after CONFIRMED quarantines; hearsay FAILED contests", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.book.line(ACCOUNT, PUSD)?.actual).toBe("90");
    expect(code(h.manager.resolveByReconciliation("op", auth("NOT_FOUND", TX_A)))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(h.manager.operation("op")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_A}`] });
    const g = await submitted(SPLIT);
    g.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(code(g.manager.resolveByReconciliation("op", { ...auth("FAILED", TX_A), source: "HEARSAY" }))).toBe(
      "WALLET_OP_ILLEGAL_TRANSITION",
    );
    expect(g.manager.operation("op")?.quarantined).toBe(true);
  });

  it("in flight, a refused authoritative answer is applied like the same observation (never dropped)", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
    // Not under reconciliation: refused as a resolution, applied as an observation.
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A)))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(h.manager.operation("op")).toMatchObject({ state: "CONFIRMED", effectsApplied: true });
    // A later FAILED(A) observation now contests it instead of concluding FAILED and releasing.
    h.manager.observe("op", { status: "FAILED", transactionHash: TX_A, transactionId: null });
    expect(h.manager.operation("op")?.quarantined).toBe(true);
    expect(wholeBalanceReservable(h, { ...SPLIT, balance: "90" })).toBe(false);
  });

  it("an authoritative repeat of what still stands carries no new fact: no set-aside, no request (an observation of it would)", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    h.manager.observe("op", { status: "MINED", transactionHash: TX_C });
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
    const before = h.reconciler.requests.length;
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe(
      "WALLET_OP_EVIDENCE_REQUIRED",
    );
    expect(h.reconciler.requests).toHaveLength(before);
    expect(h.manager.operation("op")).toMatchObject({ unresolvedTransactions: [`hash:${TX_C}`], reopenedTransactions: [] });
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_C, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("CONFIRMED");
    // Control: the same FAILED(B) as an observation (directive 3) would have set A aside.
    const g = await submitted(SPLIT);
    g.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    g.manager.observe("op", { status: "MINED", transactionHash: TX_C });
    g.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, g.reconciler.latest()));
    g.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, g.reconciler.latest()));
    g.manager.observe("op", { status: "FAILED", transactionHash: TX_B, transactionId: null });
    expect(g.manager.operation("op")?.reopenedTransactions).toEqual([`hash:${TX_A}`]);
  });

  it("a reconciler that answers every member on every request, in a fixed order, converges (its repeats reopen nothing)", async () => {
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "MINED", transactionHash: TX_B });
    h.manager.observe("op", { status: "MINED", transactionHash: TX_C });
    // Truth: A confirmed, B and C failed. The first read of C is still pending when A and B are answered.
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, h.reconciler.latest())))).toBe("ok");
    // A doubt under C sets A's confirmation aside; from now on every request is answered for every member.
    h.manager.observe("op", { status: "FAILED", transactionHash: TX_C, transactionId: null });
    for (let round = 0; round < 3 && h.manager.operation("op")?.state === "RECONCILING"; round += 1) {
      const requestId = h.reconciler.latest();
      h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, requestId));
      h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null, requestId));
      h.manager.resolveByReconciliation("op", auth("FAILED", TX_C, null, requestId));
    }
    expect(h.manager.operation("op")).toMatchObject({ state: "CONFIRMED", quarantined: false });
  });

  it("while the executor is pending, refused answers raise no request: a reconciler answering every request cannot ping-pong", async () => {
    let answer: (value: unknown) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (answer = resolve)));
    expect(h.manager.plan({ ...SPLIT.plan, operationId: "op", accountRef: ACCOUNT }).ok).toBe(true);
    const submitting = h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED" });
    // A reconciler that answers each request it receives (here: drained in a loop) with CONFIRMED(A).
    for (let answered = 0; answered < h.reconciler.requests.length && answered < 20; answered += 1) {
      const requestId = h.reconciler.id(answered + 1);
      expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, requestId)))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    }
    expect(h.reconciler.requests).toHaveLength(1);
    // The executor answers: the request owed is sent once, and it is answerable.
    answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    await submitting;
    expect(h.reconciler.requests).toHaveLength(2);
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("CONFIRMED");
  });

  it("a request raised while another is being delivered is queued, not delivered re-entrantly: the operation stays UNKNOWN until retry", async () => {
    // Amended in r8 (setup only): the operation starts in flight under A. The r7
    // setup returned to flight after an observation was weighed under
    // reconciliation while the set was empty, which WP300-R8-02 closes.
    const h = await submitted(SPLIT);
    expect(h.manager.operation("op")?.state).toBe("SUBMITTED");
    // A synchronous reconciler: on each request it says "still in flight" under A, then reports B.
    h.reconciler.onRequest = (request) => {
      h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, request.requestId));
      h.manager.resolveByReconciliation("op", auth("MINED", TX_B, null, request.requestId));
    };
    h.manager.observe("op", { status: "DROPPED" });
    // MINED(B) in flight conflicts: back to UNKNOWN, and that request is queued, not delivered inside the call.
    expect(h.manager.operation("op")?.state).toBe("UNKNOWN");
    expect(h.manager.outstandingReconciliationRequests()).toHaveLength(1);
    expect(h.reconciler.requests).toHaveLength(1);
    h.reconciler.onRequest = undefined;
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    // The request retry delivered is the one that names B (WP300-R8: it is not dropped).
    expect(h.reconciler.requests.at(-1)?.transactionHashes).toEqual([TX_A, TX_B]);
    expectHeld(h, SPLIT);
  });
});

// ------------------------------------------------------------------ R7-X2 --

describe("WP300-R7-X2: an authoritative FAILED for a CONFIRMED approval that is not quarantined suspends it", () => {
  for (const standard of ["ERC20", "ERC1155"] as const) {
    const plan =
      standard === "ERC20"
        ? { type: "APPROVE_ERC20", operationId: "ap", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" }
        : { type: "APPROVE_ERC1155", operationId: "ap", accountRef: ACCOUNT, spender: CTF_EXCHANGE };
    const ready = (h: Harness): boolean =>
      standard === "ERC20"
        ? h.approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE]).ready
        : h.approvals.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready;
    const sync = (h: Harness): void =>
      standard === "ERC20"
        ? h.approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" })
        : h.approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });

    for (const route of ["authoritative", "observation (control)"] as const) {
      it(`${standard}: in-flight CONFIRMED(A), ready; FAILED(A) via the ${route}: suspended, never ready after a sync`, async () => {
        const h = harness();
        expect(h.manager.plan(plan).ok).toBe(true);
        await h.manager.submit("ap");
        h.manager.observe("ap", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
        sync(h);
        expect(ready(h)).toBe(true);
        const result =
          route === "authoritative"
            ? h.manager.resolveByReconciliation("ap", auth("FAILED", TX_A))
            : h.manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
        if (route === "authoritative") expect(code(result)).toBe("WALLET_OP_ILLEGAL_TRANSITION");
        expect(h.approvals.approvalStatus("ap")).toBe("SUSPENDED");
        sync(h);
        expect(ready(h)).toBe(false);
        expect(h.manager.operation("ap")?.quarantined).toBe(true);
        // Recovery: the authority answers the quarantine's request FAILED: the approval is discarded.
        expect(code(h.manager.resolveByReconciliation("ap", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
        sync(h);
        expect(ready(h)).toBe(false);
        expect(h.approvals.approvalStatus("ap")).toBe("NONE");
      });
    }

    it(`${standard}: concluded by the authority's CONFIRMED(A) in simple mode, then its FAILED(A): suspended`, async () => {
      const h = harness();
      expect(h.manager.plan(plan).ok).toBe(true);
      await h.manager.submit("ap");
      h.manager.observe("ap", { status: "DROPPED" });
      expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      sync(h);
      expect(ready(h)).toBe(true);
      expect(code(h.manager.resolveByReconciliation("ap", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe(
        "WALLET_OP_ILLEGAL_TRANSITION",
      );
      sync(h);
      expect(ready(h)).toBe(false);
      expect(h.approvals.approvalStatus("ap")).toBe("SUSPENDED");
    });
  }
});

// ------------------------------------------------------------------ R7-X4 --

describe("WP300-R7-X4: the pairing still assumed is the one the headers state", () => {
  it("simple mode (one hash, one relayer id, nothing weighed under reconciliation): one answer naming any member concludes", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R }));
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A, transactionId: ID_R });
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R)))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });

  it("once anything is weighed under reconciliation, no pairing is assumed: every member is answered by name", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R }));
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A, transactionId: ID_R });
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `id:${ID_R}`]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expectHeld(h, SPLIT);
  });
});

// ------------------------------------------------- superseded, in flight --

describe("WP300-R7-X3 in flight: a superseded answer never concludes; it sends the operation back to reconciliation", () => {
  for (const named of [false, true]) {
    it(`a superseded FAILED${named ? "(A)" : ""} delivered after reconciliation returned the operation to flight releases nothing`, async () => {
      // Amended in r8 (setup only): the r7 setup returned to flight after an
      // observation was weighed under reconciliation while the set was empty,
      // which WP300-R8-02 closes. Here nothing is weighed before the return to
      // flight; the read is superseded by the operation re-entering reconciliation.
      const h = await submitted(SPLIT);
      // In flight, DROPPED: UNKNOWN, then RECONCILING with request 1.
      h.manager.observe("op", { status: "DROPPED" });
      expect(h.manager.operation("op")?.state).toBe("RECONCILING");
      // A job reads FAILED for request 1 (delivered later).
      const stale = auth("FAILED", named ? TX_A : null, null, h.reconciler.id(1));
      // Another job says "still in flight" for request 1, then the operation re-enters reconciliation: request 2.
      expect(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, h.reconciler.id(1))))).toBe("ok");
      h.manager.observe("op", { status: "UNKNOWN" });
      expect(h.reconciler.requests).toHaveLength(2);
      // Reconciliation says "still in flight" for request 2: the operation returns to SUBMITTED.
      expect(code(h.manager.resolveByReconciliation("op", auth("SUBMITTED", TX_A, null, h.reconciler.id(2))))).toBe("ok");
      expect(h.manager.operation("op")?.state).toBe("SUBMITTED");
      // The decisive step: the stale read arrives in flight. It is not applied as an observation.
      expect(code(h.manager.resolveByReconciliation("op", stale))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expect(h.manager.operation("op")?.state).toBe("RECONCILING");
      expectHeld(h, SPLIT);
      // Control: a current FAILED(A) read concludes.
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      expect(h.manager.operation("op")?.state).toBe("FAILED");
    });
  }

  it("added in r8 (restores the R7-X3-o coverage the amended setup above no longer gives): an unnamed claim concerns a transaction named later without a mark", async () => {
    // The executor's late answer admits its identity without a mark, so only the
    // unnamed claim's mark on the operation as a whole can supersede the read.
    let answer: (value: unknown) => void = () => undefined;
    const pending = new Promise<unknown>((resolve) => {
      answer = resolve;
    });
    const h = harness(() => pending);
    expect(h.manager.plan({ ...SPLIT.plan, operationId: "op", accountRef: ACCOUNT }).ok).toBe(true);
    const submitting = h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED" });
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    // A job reads FAILED(A) for request 1 (delivered later).
    const stale = auth("FAILED", TX_A, null, h.reconciler.id(1));
    // An unrecognised observation naming nothing: a claim about the whole operation.
    h.manager.observe("op", { status: "UNKNOWN" });
    answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    await submitting;
    expect(h.manager.operation("op")?.transactionHashes).toEqual([TX_A]);
    expect(code(h.manager.resolveByReconciliation("op", stale))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    expectHeld(h, SPLIT);
  });

  it("a current refused answer in flight is applied like the same observation (WP300-R7-X1 parity; the contrast to the superseded case)", async () => {
    // Amended in r8 (setup only; see above): in flight under A, DROPPED raises request 1.
    const h = await submitted(SPLIT);
    h.manager.observe("op", { status: "DROPPED" });
    expect(code(h.manager.resolveByReconciliation("op", auth("SUBMITTED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe(
      "WALLET_OP_ILLEGAL_TRANSITION",
    );
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });
});
