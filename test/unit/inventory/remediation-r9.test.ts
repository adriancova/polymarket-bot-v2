/**
 * WP-300 remediation round 9: pins for the reconciled findings
 * - WP300-R9-01 (HIGH): evidence that accompanied or triggered a return to
 *   UNKNOWN was never weighed — observations buffered while the executor call
 *   was pending were discarded, and the claim that sent the operation back was
 *   not weighed either — so simple mode survived, a single-identifier answer
 *   concluded for a member a discarded claim named, and (with no earlier
 *   request) an answer echoing no request, read before the claim, stayed
 *   current. Every such piece of evidence is now weighed under reconciliation,
 *   exactly as the same fact observed one step later would be;
 * - WP300-R9-02 (LOW): an executor NOT_SENT naming a transaction was accepted
 *   as NOT_SENT and released at once;
 * - WP300-R9-03 (LOW): a NON-authoritative terminal answer for a superseded (or
 *   foreign) request was applied in flight and could conclude;
 * - WP300-R9-04 (LOW): an operation sent back to UNKNOWN inside a synchronous
 *   delivery was moved to RECONCILING by the outer delivery when the newest
 *   request raised inside it did not advance.
 * Each pin fails against the round-8 candidate (4a08929) and passes after the
 * fix; controls and guards (marked as such) pass on both. Since WP300-R9-01
 * the one in-flight trigger that weighs nothing is a stale SUBMITTED after
 * MINED, so the setups that need simple mode, or a return to flight after a
 * re-entry, use it. The seeded interleaving property
 * (`wallet-evidence.property.test.ts`) reaches these paths too.
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
const ID_S = "sanitized-relayer-id-s";

const hashKey = (hash: string): string => `hash:${hash}`;
const idKey = (id: string): string => `id:${id}`;

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  onRequest: ((request: ReconciliationRequest) => void) | undefined;
  request(request: ReconciliationRequest): void {
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

/** An executor whose answer the test gives later (or makes it throw). */
function pendingExecutor(): { submit: () => Promise<unknown>; answer: (value: unknown) => void; fail: () => void } {
  let resolve: (value: unknown) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { submit: () => promise, answer: (value) => resolve(value), fail: () => reject(new Error("socket closed")) };
}

function harness(submit: () => Promise<unknown> = () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R })) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const reconciler = new Reconciler();
  const approvals = new ApprovalTracker();
  const executor: WalletOperationExecutor = { submit };
  const manager = new WalletOperationManager({ book, approvals, executor, reconciler });
  return { book, reconciler, approvals, manager };
}

type Harness = ReturnType<typeof harness>;

/** An authoritative read reported as an answer; `requestId` is the request it was read for (none: unbound). */
const auth = (
  state: string,
  transactionHash: string | null,
  transactionId: string | null = null,
  requestId?: string,
  credited?: string,
) => ({
  source: "AUTHORITATIVE_READ",
  state,
  transactionHash,
  transactionId,
  ...(requestId === undefined ? {} : { requestId }),
  ...(credited === undefined ? {} : { credited }),
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
  /** A CONFIRMED for this type carries the observed credited amount. */
  readonly credited: string | undefined;
}

const VALUE_OPS: readonly ValueOp[] = [
  { type: "SPLIT", plan: { type: "SPLIT", conditionId: CONDITION, amount: "10" }, asset: PUSD, amount: "10", balance: "100", credited: undefined },
  { type: "MERGE", plan: { type: "MERGE", conditionId: CONDITION, amount: "5" }, asset: YES, amount: "5", balance: "20", credited: undefined },
  {
    type: "REDEEM",
    plan: { type: "REDEEM", conditionId: CONDITION, resolution: "YES_WIN", yesAmount: "5" },
    asset: YES,
    amount: "5",
    balance: "20",
    credited: "5",
  },
  { type: "WRAP_COLLATERAL", plan: { type: "WRAP_COLLATERAL", amount: "10" }, asset: USDC_E, amount: "10", balance: "50", credited: "10" },
  { type: "UNWRAP_COLLATERAL", plan: { type: "UNWRAP_COLLATERAL", amount: "10" }, asset: PUSD, amount: "10", balance: "100", credited: "10" },
];

const SPLIT = VALUE_OPS[0] as ValueOp;
const CREDIT_OPS = VALUE_OPS.filter((op) => op.credited !== undefined);

const confirmedOf = (op: ValueOp, hash: string, id: string | null) => ({
  status: "CONFIRMED",
  transactionHash: hash,
  transactionId: id,
  ...(op.credited === undefined ? {} : { credited: op.credited }),
});

/** Whether the whole balance of the operation's reserved asset can be reserved (the collateral was released). */
function wholeBalanceReservable(h: Harness, op: ValueOp, id = "all"): boolean {
  const result = h.book.reserve({ reservationId: id, holderRef: `holder-${id}`, accountRef: ACCOUNT, assetId: op.asset, amount: op.balance });
  if (result.ok) h.book.release({ reservationId: id });
  return result.ok;
}

function expectHeld(h: Harness, op: ValueOp, operationId = "op"): void {
  expect(h.manager.operation(operationId)?.state).toBe("RECONCILING");
  expect(h.book.line(ACCOUNT, op.asset)?.reserved).toBe(op.amount);
  expect(wholeBalanceReservable(h, op)).toBe(false);
}

function planOp(h: Harness, op: ValueOp, operationId = "op"): void {
  expect(h.manager.plan({ ...op.plan, operationId, accountRef: ACCOUNT }).ok).toBe(true);
}

async function submitted(op: ValueOp, submit?: () => Promise<unknown>): Promise<Harness> {
  const h = harness(submit);
  planOp(h, op);
  await h.manager.submit("op");
  return h;
}

/**
 * Back under reconciliation with NOTHING weighed (simple mode): the only route
 * since WP300-R9-01 is a stale lifecycle report — SUBMITTED after MINED — which
 * changes nothing when weighed. In flight under (A, R): MINED(A, R), then
 * SUBMITTED(A, R) → UNKNOWN → RECONCILING (request 1).
 */
function reconcilingByRegression(h: Harness, operationId = "op"): void {
  h.manager.observe(operationId, { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
  h.manager.observe(operationId, { status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R });
  expect(h.manager.operation(operationId)?.state).toBe("RECONCILING");
  expect(h.manager.operation(operationId)?.unresolvedTransactions).toEqual([]);
}

/**
 * Back in flight after a re-entry, nothing weighed (WP300-R8-01's setup, by
 * the regression route): submitted under A; request 1 by a regression; MINED(A)
 * for it → in flight; a second regression → request 2 (a re-entry, which
 * supersedes request 1); MINED(A) for request 2 → in flight. Returns the id of
 * request 1.
 */
function backInFlightAfterReentry(h: Harness, operationId = "op"): string {
  h.manager.observe(operationId, { status: "MINED", transactionHash: TX_A });
  h.manager.observe(operationId, { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
  expect(h.manager.operation(operationId)?.state).toBe("RECONCILING");
  const first = h.reconciler.latest();
  expect(code(h.manager.resolveByReconciliation(operationId, auth("MINED", TX_A, null, first)))).toBe("ok");
  h.manager.observe(operationId, { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
  expect(h.manager.operation(operationId)?.state).toBe("RECONCILING");
  expect(code(h.manager.resolveByReconciliation(operationId, auth("MINED", TX_A, null, h.reconciler.latest())))).toBe("ok");
  expect(h.manager.operation(operationId)?.state).toBe("MINED");
  expect(h.manager.operation(operationId)?.unresolvedTransactions).toEqual([]);
  return first;
}

// ---------------------------------------------------------------- R9-01 --

/**
 * What sends an operation with a pending executor call back to UNKNOWN while
 * observations are buffered. `claimAfter` says the claim under test is
 * buffered AFTER the trigger's own setup observation (the drain regression).
 */
interface BufferTrigger {
  readonly label: string;
  /** Observations buffered before the claim, besides MINED(A, R). */
  readonly before: readonly Readonly<Record<string, unknown>>[];
  /** Observations buffered after the claim. */
  readonly after: readonly Readonly<Record<string, unknown>>[];
  readonly fire: (h: Harness, executor: ReturnType<typeof pendingExecutor>, operationId: string) => void;
  /** Whether a control (the claim observed one step later instead) exists for this trigger. */
  readonly control: boolean;
}

const BUFFER_TRIGGERS: readonly BufferTrigger[] = [
  { label: "the executor answers NOT_SENT", before: [], after: [], fire: (_h, e) => e.answer({ status: "NOT_SENT" }), control: true },
  { label: "the executor's answer is unrecognised", before: [], after: [], fire: (_h, e) => e.answer({ status: "???" }), control: true },
  { label: "the executor throws", before: [], after: [], fire: (_h, e) => e.fail(), control: true },
  {
    label: "an unrecognised observation (DROPPED) arrives",
    before: [],
    after: [],
    fire: (h, e, operationId) => {
      h.manager.observe(operationId, { status: "DROPPED" });
      e.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R });
    },
    control: true,
  },
  {
    label: "the drain finds a conflict (MINED after the terminal claim)",
    before: [],
    after: [{ status: "MINED", transactionHash: TX_A, transactionId: ID_R }],
    fire: (_h, e) => e.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R }),
    control: false,
  },
  {
    label: "the drain applies a regression (SUBMITTED after MINED) before the claim",
    before: [{ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R }],
    after: [],
    fire: (_h, e) => e.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R }),
    control: true,
  },
];

/** Plan, start submitting, buffer MINED(A, R) + the trigger's setup (+ the claim, unless it is the control), fire. */
async function bufferedThenTrigger(
  h: Harness,
  executor: ReturnType<typeof pendingExecutor>,
  trigger: BufferTrigger,
  claim: Readonly<Record<string, unknown>> | null,
  operationId = "op",
): Promise<void> {
  const submitting = h.manager.submit(operationId);
  h.manager.observe(operationId, { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
  for (const observation of trigger.before) h.manager.observe(operationId, observation);
  if (claim !== null) {
    const kept = h.manager.observe(operationId, claim);
    expect(kept.ok && kept.value.state).toBe("PLANNED");
  }
  for (const observation of trigger.after) h.manager.observe(operationId, observation);
  trigger.fire(h, executor, operationId);
  await submitting;
  expect(h.manager.operation(operationId)?.state).toBe("RECONCILING");
  expect(h.manager.operation(operationId)?.bufferedObservations).toBe(0);
}

describe("WP300-R9-01: observations buffered while the executor call is pending are weighed when the operation goes back to UNKNOWN", () => {
  for (const op of VALUE_OPS) {
    for (const trigger of BUFFER_TRIGGERS) {
      it(`${op.type}: a buffered CONFIRMED(A), then ${trigger.label}: a current FAILED(null, R) releases nothing`, async () => {
        const executor = pendingExecutor();
        const h = harness(executor.submit);
        planOp(h, op);
        await bufferedThenTrigger(h, executor, trigger, confirmedOf(op, TX_A, null));
        // The decisive step: a compliant reconciler's bound, current answer naming R only.
        expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
        expectHeld(h, op);
        expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
        // Liveness: A answered by name concludes.
        expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
        expect(h.manager.operation("op")?.state).toBe("FAILED");
        expect(wholeBalanceReservable(h, op)).toBe(true);
      });

      if (trigger.control) {
        it(`${op.type}: control — ${trigger.label}, then the same CONFIRMED(A) observed under reconciliation holds the same way`, async () => {
          const executor = pendingExecutor();
          const h = harness(executor.submit);
          planOp(h, op);
          await bufferedThenTrigger(h, executor, trigger, null);
          h.manager.observe("op", confirmedOf(op, TX_A, null));
          expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
          expectHeld(h, op);
          expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
        });
      }
    }
  }

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
    const failedR = { status: "FAILED", transactionHash: null, transactionId: ID_R };

    for (const trigger of BUFFER_TRIGGERS) {
      it(`${standard}: a buffered FAILED(null, R), then ${trigger.label}: a current CONFIRMED(A) is never ready after a sync`, async () => {
        const executor = pendingExecutor();
        const h = harness(executor.submit);
        expect(h.manager.plan(plan).ok).toBe(true);
        await bufferedThenTrigger(h, executor, trigger, failedR, "ap");
        expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
        sync(h);
        expect(ready(h)).toBe(false);
        expect(h.manager.operation("ap")?.state).toBe("RECONCILING");
        expect(h.manager.operation("ap")?.unresolvedTransactions).toEqual([idKey(ID_R)]);
      });

      if (trigger.control) {
        it(`${standard}: control — ${trigger.label}, then the same FAILED(null, R) observed under reconciliation: never ready`, async () => {
          const executor = pendingExecutor();
          const h = harness(executor.submit);
          expect(h.manager.plan(plan).ok).toBe(true);
          await bufferedThenTrigger(h, executor, trigger, null, "ap");
          h.manager.observe("ap", failedR);
          expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
          sync(h);
          expect(ready(h)).toBe(false);
        });
      }
    }
  }

  it("the buffer is weighed in arrival order, the trigger last: the request carries every member, and only then is it delivered", async () => {
    const executor = pendingExecutor();
    const h = harness(executor.submit);
    planOp(h, SPLIT);
    const submitting = h.manager.submit("op");
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    // A synchronous reconciler answers the request it receives, bound to it, naming R only.
    const results: (string | undefined)[] = [];
    h.reconciler.onRequest = (request) => {
      results.push(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, request.requestId))));
    };
    executor.fail();
    await submitting;
    h.reconciler.onRequest = undefined;
    expect(h.reconciler.requests).toHaveLength(1);
    expect(h.reconciler.requests[0]?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
    // The executor call had answered (thrown): the synchronous answer was accepted, for R only.
    expect(results).toEqual(["ok"]);
    expectHeld(h, SPLIT);
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
  });
});

describe("WP300-R9-01: what a kept lifecycle report first named counts as named by it when it is weighed", () => {
  // The executor THROWS: its own uncertainty, which is not weighed, so only the kept report can end simple mode.
  for (const op of VALUE_OPS) {
    it(`${op.type}: a kept MINED(A, R), then the executor throws: a current FAILED(null, R) does not conclude for A, and an unbound FAILED(A) is superseded`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
      executor.fail();
      await submitting;
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
    });

    it(`${op.type}: control — the executor throws, then the same MINED(A, R) observed under reconciliation holds the same way`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      executor.fail();
      await submitting;
      h.manager.observe("op", { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
    });
  }

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

    it(`${standard}: a kept MINED(A, R), then the executor throws: a current CONFIRMED(A) is never ready after a sync`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      expect(h.manager.plan(plan).ok).toBe(true);
      const submitting = h.manager.submit("ap");
      h.manager.observe("ap", { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
      executor.fail();
      await submitting;
      expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      sync(h);
      expect(ready(h)).toBe(false);
      expect(h.manager.operation("ap")?.unresolvedTransactions).toEqual([idKey(ID_R)]);
    });

    it(`${standard}: control — the executor throws, then the same MINED(A, R) observed under reconciliation: never ready`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      expect(h.manager.plan(plan).ok).toBe(true);
      const submitting = h.manager.submit("ap");
      executor.fail();
      await submitting;
      h.manager.observe("ap", { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
      expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      sync(h);
      expect(ready(h)).toBe(false);
    });
  }
});

describe("WP300-R9-01: the executor's own answer, when it arrives with or after other evidence, is weighed like the same fact from any other source", () => {
  for (const late of ["NOT_SENT", "???"] as const) {
    it(`a kept FAILED naming nothing, then the executor's ${late} (a contradiction): an unbound FAILED read before it is superseded`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, SPLIT);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", { status: "FAILED", transactionHash: null, transactionId: null });
      executor.answer({ status: late });
      await submitting;
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, SPLIT);
      // A current answer concludes (nothing was named).
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, null, h.reconciler.latest())))).toBe("ok");
      expect(h.manager.operation("op")?.state).toBe("FAILED");
    });
  }

  it("control (the contrast): a kept FAILED naming nothing, then the executor throws (no fact): the same unbound FAILED is current and concludes", async () => {
    const executor = pendingExecutor();
    const h = harness(executor.submit);
    planOp(h, SPLIT);
    const submitting = h.manager.submit("op");
    h.manager.observe("op", { status: "FAILED", transactionHash: null, transactionId: null });
    executor.fail();
    await submitting;
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, null)))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });

  for (const op of VALUE_OPS) {
    it(`${op.type}: DROPPED(A) while the executor is pending, then its late SUBMITTED(A, R) names R first: an unbound FAILED(null, R) read before is superseded`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
      executor.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R });
      await submitting;
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
    });

    it(`${op.type}: control — the executor's late SUBMITTED(A), then the same SUBMITTED(A, R) observed: the unbound FAILED(null, R) is superseded the same way`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
      executor.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      await submitting;
      h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, op);
    });

    it(`${op.type}: a kept MINED(A), then the executor's SUBMITTED(B) (the drain conflicts): unbound FAILED(B) and FAILED(A) read before are superseded`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
      executor.answer({ status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
      await submitting;
      expect(h.manager.operation("op")?.state).toBe("RECONCILING");
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, op);
    });

    it(`${op.type}: control — a kept MINED(A), the executor throws, then SUBMITTED(B) observed: the unbound FAILED(B) is superseded the same way`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
      executor.fail();
      await submitting;
      h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, op);
    });
  }

  it("control (documented): the executor's own unrecognised answer naming (A, R), with nothing kept, is not weighed — simple mode, FAILED(null, R) concludes (the disclosed pairing)", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "???", transactionHash: TX_A, transactionId: ID_R }));
    expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", transactionHashes: [TX_A], transactionIds: [ID_R], unresolvedTransactions: [] });
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });
});

describe("WP300-R9-01: the claim that sends an operation back to UNKNOWN is weighed like the same fact observed one step later", () => {
  for (const op of VALUE_OPS) {
    it(`${op.type}: an unrecognised observation naming A and R in flight (malformed CONFIRMED): a current FAILED(null, R) releases nothing`, async () => {
      const h = await submitted(op);
      h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: ID_R, credited: "not-an-amount" });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
    });

    it(`${op.type}: control — the same malformed CONFIRMED observed under reconciliation holds the same way`, async () => {
      const h = await submitted(op);
      reconcilingByRegression(h);
      h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: ID_R, credited: "not-an-amount" });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
    });

    it(`${op.type}: a bare DROPPED in flight under (A, R): a current FAILED(null, R) releases nothing`, async () => {
      const h = await submitted(op);
      h.manager.observe("op", { status: "DROPPED" });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
    });

    it(`${op.type}: control — the same DROPPED observed under reconciliation holds the same way`, async () => {
      const h = await submitted(op);
      reconcilingByRegression(h);
      h.manager.observe("op", { status: "DROPPED" });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
    });

    it(`${op.type}: a bare DROPPED while the executor is pending, then its late SUBMITTED(A, R): a current FAILED(null, R) releases nothing`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", { status: "DROPPED" });
      executor.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R });
      await submitting;
      expect(h.reconciler.requests.at(-1)?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
    });

    it(`${op.type}: a CONFIRMED(B) in flight under A (a conflict), then answers echoing no request read before it: FAILED(B) is superseded, nothing is released`, async () => {
      const h = await submitted(op, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
      h.manager.observe("op", confirmedOf(op, TX_B, null));
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null));
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toContain(hashKey(TX_B));
    });

    it(`${op.type}: control — the same CONFIRMED(B) observed under reconciliation: the unbound FAILED(B) is superseded the same way`, async () => {
      const h = await submitted(op, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
      h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
      h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      h.manager.observe("op", confirmedOf(op, TX_B, null));
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_B, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null));
      expectHeld(h, op);
    });

    it(`${op.type}: a CONFIRMED(A, S) in flight under (A, R) (a relayer-id conflict), then unbound FAILED answers read before it: nothing is released`, async () => {
      const h = await submitted(op);
      h.manager.observe("op", confirmedOf(op, TX_A, ID_S));
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_S)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, ID_R));
      expectHeld(h, op);
    });

    it(`${op.type}: a buffered CONFIRMED(A), then the executor's unrecognised answer: an answer echoing no request, read before, is superseded`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", confirmedOf(op, TX_A, null));
      executor.answer({ status: "???" });
      await submitting;
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, op);
    });

    it(`${op.type}: a buffered CONFIRMED(A), then UNKNOWN observed and the executor's late SUBMITTED(A): an unbound FAILED(A) is superseded`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, op);
      const submitting = h.manager.submit("op");
      h.manager.observe("op", confirmedOf(op, TX_A, null));
      h.manager.observe("op", { status: "UNKNOWN" });
      executor.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      await submitting;
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, op);
    });
  }

  for (const op of CREDIT_OPS) {
    it(`${op.type}: CONFIRMED(A) without the observed credited amount in flight under (A, R): a current FAILED(null, R) releases nothing`, async () => {
      const h = await submitted(op);
      h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
    });

    it(`${op.type}: control — the same CONFIRMED(A) without a credited amount observed under reconciliation holds the same way`, async () => {
      const h = await submitted(op);
      reconcilingByRegression(h);
      h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
    });
  }

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

    it(`${standard}: a bare DROPPED in flight under (A, R): a current CONFIRMED(A) is never ready after a sync`, async () => {
      const h = harness();
      expect(h.manager.plan(plan).ok).toBe(true);
      await h.manager.submit("ap");
      h.manager.observe("ap", { status: "DROPPED" });
      expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      sync(h);
      expect(ready(h)).toBe(false);
      expect(h.manager.operation("ap")?.unresolvedTransactions).toEqual([idKey(ID_R)]);
    });

    it(`${standard}: a FAILED(B) in flight under A (a conflict), then an unbound CONFIRMED(B) read before it is superseded: never ready`, async () => {
      const h = harness(() => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
      expect(h.manager.plan(plan).ok).toBe(true);
      await h.manager.submit("ap");
      h.manager.observe("ap", { status: "FAILED", transactionHash: TX_B, transactionId: null });
      expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_B, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null));
      sync(h);
      expect(ready(h)).toBe(false);
    });

    it(`${standard}: a buffered FAILED(A), then the executor's unrecognised answer: an unbound CONFIRMED(A) read before is superseded; never ready`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      expect(h.manager.plan(plan).ok).toBe(true);
      const submitting = h.manager.submit("ap");
      h.manager.observe("ap", { status: "FAILED", transactionHash: TX_A, transactionId: null });
      executor.answer({ status: "???" });
      await submitting;
      expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      sync(h);
      expect(ready(h)).toBe(false);
    });
  }

  it("the verifiers' in-flight variant (DROPPED, MINED(A, R) for request 1, CONFIRMED(A), late NOT_SENT): the route back to flight is closed and nothing is released", async () => {
    const executor = pendingExecutor();
    const h = harness(executor.submit);
    planOp(h, SPLIT);
    const submitting = h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED" });
    // The DROPPED was weighed under reconciliation: "still in flight" is refused, and weighed.
    expect(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, ID_R, h.reconciler.latest())))).toBe(
      "WALLET_OP_EVIDENCE_REQUIRED",
    );
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    executor.answer({ status: "NOT_SENT" });
    await submitting;
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
    expectHeld(h, SPLIT);
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
  });

  it("in flight while the executor call is pending is no longer reachable: a 'still in flight' answer after a weighed trigger is refused, also synchronously", async () => {
    for (const synchronous of [false, true]) {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      planOp(h, SPLIT);
      const submitting = h.manager.submit("op");
      const results: (string | undefined)[] = [];
      if (synchronous) {
        h.reconciler.onRequest = (request) => {
          results.push(code(h.manager.resolveByReconciliation("op", auth("SUBMITTED", TX_A, null, request.requestId))));
        };
      }
      h.manager.observe("op", { status: "UNKNOWN" });
      h.reconciler.onRequest = undefined;
      if (!synchronous) results.push(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, h.reconciler.latest()))));
      expect(results).toEqual(["WALLET_OP_EVIDENCE_REQUIRED"]);
      expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", submitting: true });
      executor.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      await submitting;
      expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    }
  });

  it("control (documented: the first entry into reconciliation marks nothing by itself): after the executor's own uncertainty with nothing buffered, an answer echoing no request is current", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "???" }));
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, null)))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });
});

describe("guards added in r9 (they pin earlier mechanisms; they pass on 4a08929 too)", () => {
  it("restores the R7-X3-o coverage: a claim naming nothing supersedes a read naming a transaction no evidence had named, which an answer would admit without a mark", async () => {
    // The r8 guard (remediation-r7.test.ts) relied on the executor's late answer admitting its identity
    // without a mark; since WP300-R9-01 that answer is weighed and marks what it names first. Here the
    // transaction is named only by the stale answer itself, so only the unnamed claim's mark on the
    // operation as a whole can supersede it.
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "???" }));
    expect(h.manager.operation("op")?.transactionHashes).toEqual([]);
    // A job reads FAILED(A) for request 1 (delivered later).
    const stale = auth("FAILED", TX_A, null, h.reconciler.id(1));
    // An unrecognised observation naming nothing: a claim about the whole operation (request 2).
    h.manager.observe("op", { status: "UNKNOWN" });
    expect(h.reconciler.requests).toHaveLength(2);
    expect(code(h.manager.resolveByReconciliation("op", stale))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    expectHeld(h, SPLIT);
  });
});

// ---------------------------------------------------------------- R9-02 --

describe("WP300-R9-02: an executor NOT_SENT that names a transaction is unrecognised, never a release", () => {
  for (const [label, answer] of [
    ["a hash", { status: "NOT_SENT", transactionHash: TX_A }],
    ["a relayer id", { status: "NOT_SENT", transactionId: ID_R }],
    ["a hash and a relayer id", { status: "NOT_SENT", transactionHash: TX_A, transactionId: ID_R }],
    ["a malformed hash field", { status: "NOT_SENT", transactionHash: 42 }],
    ["an empty relayer id", { status: "NOT_SENT", transactionId: "" }],
  ] as const) {
    it(`NOT_SENT naming ${label}: UNKNOWN, reconciliation at once, the reservation held`, async () => {
      const h = await submitted(SPLIT, () => Promise.resolve(answer));
      expect(h.manager.operation("op")?.state).toBe("RECONCILING");
      expect(h.manager.events("op").map((e) => e.newState)).toEqual(["PLANNED", "UNKNOWN", "RECONCILING"]);
      expect(h.reconciler.requests).toHaveLength(1);
      expectHeld(h, SPLIT);
    });
  }

  it("the witnessed identity is kept: it is a member of the set the request carries", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "NOT_SENT", transactionHash: TX_A, transactionId: ID_R }));
    expect(h.reconciler.requests[0]).toMatchObject({ transactionHashes: [TX_A], transactionIds: [ID_R] });
  });

  for (const [label, answer] of [
    ["a plain NOT_SENT", { status: "NOT_SENT" }],
    ["a NOT_SENT with null identity fields", { status: "NOT_SENT", transactionHash: null, transactionId: null }],
  ] as const) {
    it(`control: ${label} is recognised: FAILED, released at once, no request`, async () => {
      const h = await submitted(SPLIT, () => Promise.resolve(answer));
      expect(h.manager.operation("op")?.state).toBe("FAILED");
      expect(h.reconciler.requests).toEqual([]);
      expect(wholeBalanceReservable(h, SPLIT)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------- R9-03 --

describe("WP300-R9-03: a superseded terminal answer is never applied in flight, authoritative or not", () => {
  for (const source of ["RELAYER_STATUS", "AUTHORITATIVE_READ"] as const) {
    // The AUTHORITATIVE_READ rows are controls: the authoritative twin has been held since r8 (WP300-R8-01).
    const tag = source === "AUTHORITATIVE_READ" ? "control (the authoritative twin) — " : "";
    const answer = (state: string, hash: string | null, id: string | null, requestId?: string) => ({
      source,
      state,
      transactionHash: hash,
      transactionId: id,
      ...(requestId === undefined ? {} : { requestId }),
    });

    it(`${tag}${source}: FAILED(A) read for request 1, delivered back in flight after a re-entry, sends the operation back: nothing is released`, async () => {
      const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
      const first = backInFlightAfterReentry(h);
      expect(code(h.manager.resolveByReconciliation("op", answer("FAILED", TX_A, null, first)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, SPLIT);
    });

    it(`${tag}${source}: FAILED(A) naming a request not issued for the operation, in flight: nothing is released`, async () => {
      const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
      expect(code(h.manager.resolveByReconciliation("op", answer("FAILED", TX_A, null, "wallet-op:other:reconciliation:1")))).toBe(
        "WALLET_OP_EVIDENCE_SUPERSEDED",
      );
      expectHeld(h, SPLIT);
    });

    it(`${tag}${source}: an unbound FAILED(A) back in flight after a re-entry: nothing is released`, async () => {
      const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
      backInFlightAfterReentry(h);
      expect(code(h.manager.resolveByReconciliation("op", answer("FAILED", TX_A, null)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expectHeld(h, SPLIT);
    });

    it(`${tag}${source}: CONFIRMED(C) read for request 1, delivered back in flight: weighed, C admitted and required`, async () => {
      const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
      const first = backInFlightAfterReentry(h);
      expect(code(h.manager.resolveByReconciliation("op", answer("CONFIRMED", TX_C, null, first)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A), hashKey(TX_C)]);
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, SPLIT);
    });
  }

  it("control (the in-flight trust boundary): a CURRENT non-authoritative FAILED(A) in flight is applied like the same observation", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
    backInFlightAfterReentry(h);
    const current = { source: "RELAYER_STATUS", state: "FAILED", transactionHash: TX_A, transactionId: null, requestId: h.reconciler.latest() };
    expect(code(h.manager.resolveByReconciliation("op", current))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });

  it("control (documented, WP300-R9-03 ii): a superseded answer that is not terminal is applied in flight like the observation — it can teach a first relayer id", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
    const first = backInFlightAfterReentry(h);
    expect(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, ID_R, first)))).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(h.manager.operation("op")).toMatchObject({ state: "MINED", transactionIds: [ID_R] });
  });
});

// ---------------------------------------------------------------- R9-04 --

describe("WP300-R9-04: an operation sent back to UNKNOWN inside a delivery stays UNKNOWN until retry, whatever was raised after", () => {
  it("the verifier's sequence (the newest request raised inside the delivery does not advance): UNKNOWN after the outer delivery; retry delivers a request naming everything", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
    h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    const first = h.reconciler.latest();
    expect(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, first)))).toBe("ok");
    let calls = 0;
    const inner: (string | undefined)[] = [];
    h.reconciler.onRequest = (request) => {
      calls += 1;
      if (calls > 1) return;
      // 1. "Still in flight" for the request being delivered: back in flight.
      inner.push(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, request.requestId))));
      // 2. A stale CONFIRMED(C, R) for request 1 arrives in flight: sent back to UNKNOWN (an advancing request is queued).
      inner.push(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_C, ID_R, first))));
      // 3. A now-superseded FAILED(A) for the delivered request is weighed: a newer request that does not advance is queued.
      inner.push(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, request.requestId))));
    };
    // A second regression re-enters reconciliation and delivers request 2.
    h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    h.reconciler.onRequest = undefined;
    expect(inner).toEqual(["ok", "WALLET_OP_EVIDENCE_SUPERSEDED", "WALLET_OP_EVIDENCE_SUPERSEDED"]);
    // The decisive step: the outer delivery does not stand in for what was raised inside it.
    expect(h.manager.operation("op")?.state).toBe("UNKNOWN");
    expect(h.reconciler.requests).toHaveLength(2);
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expect(h.reconciler.requests).toHaveLength(3);
    expect(h.reconciler.requests.at(-1)?.unresolvedTransactions).toEqual([hashKey(TX_A), hashKey(TX_C), idKey(ID_R)]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expectHeld(h, SPLIT);
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_C), idKey(ID_R)]);
  });
});
