/**
 * WP-300 remediation round 8: pins for the reconciled findings
 * - WP300-R8-01 (HIGH): an authoritative terminal answer that arrived IN FLIGHT
 *   (SUBMITTED/MINED) and was refused as superseded, or named a request not
 *   issued for the operation, was thrown away with the identifiers it named,
 *   so a later answer concluded and released collateral (or made an approval
 *   ready) although the discarded answer named a new hash or relayer id. It is
 *   now weighed like the same observation outside flight — admitting what it
 *   names, contesting what it contradicts, requiring every member — once the
 *   operation is back under reconciliation and BEFORE the reconciliation
 *   request is delivered (a requester may answer synchronously);
 * - WP300-R8-02 (LOW): evidence weighed under reconciliation while the
 *   identity set was still empty did not end simple mode, so members named
 *   later were not required by name. It now does, and a late contradiction
 *   from the executor ends it too (the same statement covers it);
 * - WP300-R8-X1 (found while amending an r7 pin; not a verifier finding): an
 *   operation answered and sent back to UNKNOWN during a synchronous delivery
 *   was moved to RECONCILING by the outer delivery, so retry dropped the newer
 *   request that named the new evidence and the reconciler never received it.
 * Each pin fails against the round-7 candidate (457cede) and passes after the
 * fix; controls are marked as such. The seeded interleaving property reaches
 * these paths too (`wallet-evidence.property.test.ts`).
 *
 * Amended in r9 (setups only; each marked "Amended in r9"): since WP300-R9-01
 * the claim that sends an operation back to UNKNOWN is weighed, so a DROPPED
 * or UNKNOWN observed in flight ends simple mode and "still in flight" is
 * refused after it. Setups that needed simple mode, or a return to flight,
 * now enter reconciliation through the one in-flight trigger that weighs
 * nothing: a stale SUBMITTED after MINED.
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
import { ACCOUNT, CONDITION, CTF_EXCHANGE, NO, PUSD, USDC_E, YES, requestTokens, seededBook } from "./helpers.js";

// Valid 32-byte transaction hashes (the verifiers' probes used these shapes).
const TX_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TX_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TX_C = "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const ID_R = "sanitized-relayer-id-r";

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

function harness(submit: () => Promise<unknown> = () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null })) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const reconciler = new Reconciler();
  const approvals = new ApprovalTracker();
  const executor: WalletOperationExecutor = { submit };
  const manager = new WalletOperationManager({ requestToken: requestTokens(), book, approvals, executor, reconciler });
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

const hashKey = (hash: string): string => `hash:${hash}`;
const idKey = (id: string): string => `id:${id}`;

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

function expectHeld(h: Harness, op: ValueOp, operationId = "op"): void {
  expect(h.manager.operation(operationId)?.state).toBe("RECONCILING");
  expect(h.book.line(ACCOUNT, op.asset)?.reserved).toBe(op.amount);
  expect(wholeBalanceReservable(h, op)).toBe(false);
}

/** Answer every unresolved member FAILED by name, for the latest request: the operation concludes (liveness). */
function answerEveryMemberFailed(h: Harness, operationId = "op"): void {
  for (let i = 0; i < 6; i += 1) {
    const view = h.manager.operation(operationId);
    const open = view?.unresolvedTransactions[0];
    if (view?.state !== "RECONCILING" || open === undefined) return;
    const evidence = open.startsWith("hash:")
      ? auth("FAILED", open.slice(5), null, h.reconciler.latest())
      : auth("FAILED", null, open.slice(3), h.reconciler.latest());
    expect(code(h.manager.resolveByReconciliation(operationId, evidence))).toBe("ok");
  }
}

/**
 * The stale read: a terminal outcome naming a new hash, a new relayer id, or
 * both (a CONFIRMED always names a hash, so "a new relayer id" is CONFIRMED(A, R)).
 */
interface Stale {
  readonly label: string;
  readonly hash: (outcome: "CONFIRMED" | "FAILED") => string | null;
  readonly id: string | null;
  /** The members the stale read names that the set did not hold (it held hash A only). */
  readonly fresh: readonly string[];
}

const STALE_VARIANTS: readonly Stale[] = [
  { label: "a new hash C", hash: () => TX_C, id: null, fresh: [hashKey(TX_C)] },
  { label: "a new relayer id R", hash: (outcome) => (outcome === "CONFIRMED" ? TX_A : null), id: ID_R, fresh: [idKey(ID_R)] },
  { label: "a new hash C and a new relayer id R", hash: () => TX_C, id: ID_R, fresh: [hashKey(TX_C), idKey(ID_R)] },
];

/**
 * The Opus trigger's steps 1-5 (with any operation): submitted under A;
 * request 1; MINED(A) for request 1 → in flight; request 2 (re-entry); MINED(A)
 * for request 2 → in flight. Nothing was weighed under reconciliation (simple
 * mode). Returns the id of request 1, which the stale read was made for.
 *
 * Amended in r9 (setup only): the requests used to be raised by DROPPED(A) and
 * UNKNOWN observed in flight. Since WP300-R9-01 the claim that sends an
 * operation back to UNKNOWN is weighed (an unrecognised one ends simple mode),
 * so "still in flight" would be refused after it. The requests are now raised
 * by the one in-flight trigger that weighs nothing — a stale SUBMITTED after
 * MINED — so the operation still returns to flight after a re-entry, as the
 * stale read needs. The decisive steps are unchanged.
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

// ------------------------------------------------------------------ R8-01 --

describe("WP300-R8-01: a superseded authoritative answer arriving in flight is weighed once the operation is back under reconciliation", () => {
  for (const op of VALUE_OPS) {
    for (const stale of STALE_VARIANTS) {
      for (const outcome of ["CONFIRMED", "FAILED"] as const) {
        const read = (requestId: string) =>
          auth(outcome, stale.hash(outcome), stale.id, requestId, outcome === "CONFIRMED" ? op.credited : undefined);
        const expectedMembers = [hashKey(TX_A), ...stale.fresh];

        it(`${op.type}: a superseded ${outcome} naming ${stale.label}, delivered in flight, admits and requires it; FAILED(A) then releases nothing`, async () => {
          const h = await submitted(op);
          const first = backInFlightAfterReentry(h);
          // The decisive step: the slow read for request 1 arrives in flight.
          expect(code(h.manager.resolveByReconciliation("op", read(first)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
          const view = h.manager.operation("op");
          expect(view?.state).toBe("RECONCILING");
          expect([...(view?.unresolvedTransactions ?? [])].sort()).toEqual([...expectedMembers].sort());
          // The request it raised already carries the new members.
          const request = h.reconciler.requests.at(-1);
          expect([...(request?.unresolvedTransactions ?? [])].sort()).toEqual([...expectedMembers].sort());
          // A current FAILED(A) answers A only: nothing is released.
          expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
          expectHeld(h, op);
          expect(h.manager.operation("op")?.unresolvedTransactions).toEqual(stale.fresh);
          // Liveness: answering every remaining member by name concludes.
          answerEveryMemberFailed(h);
          expect(h.manager.operation("op")?.state).toBe("FAILED");
          expect(wholeBalanceReservable(h, op)).toBe(true);
        });

        it(`${op.type}: the same superseded ${outcome} naming ${stale.label}, with a reconciler that answers FAILED(A) synchronously inside the request: nothing is released`, async () => {
          const h = await submitted(op);
          const first = backInFlightAfterReentry(h);
          const results: (string | undefined)[] = [];
          h.reconciler.onRequest = (request) => {
            // Answers the request it receives at once (bound to it), naming A only.
            results.push(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, request.requestId))));
          };
          expect(code(h.manager.resolveByReconciliation("op", read(first)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
          h.reconciler.onRequest = undefined;
          expect(results).toEqual(["ok"]);
          expectHeld(h, op);
          expect(h.manager.operation("op")?.unresolvedTransactions).toEqual(stale.fresh);
        });

        it(`${op.type}: control — the same ${outcome} naming ${stale.label} observed once the operation is back under reconciliation holds the same way`, async () => {
          const h = await submitted(op);
          backInFlightAfterReentry(h);
          h.manager.observe("op", { status: "UNKNOWN" });
          h.manager.observe("op", {
            status: outcome,
            transactionHash: stale.hash(outcome),
            transactionId: stale.id,
            ...(outcome === "CONFIRMED" && op.credited !== undefined ? { credited: op.credited } : {}),
          });
          const view = h.manager.operation("op");
          expect(view?.state).toBe("RECONCILING");
          expect([...(view?.unresolvedTransactions ?? [])].sort()).toEqual([...expectedMembers].sort());
          expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
          expectHeld(h, op);
          expect(h.manager.operation("op")?.unresolvedTransactions).toEqual(stale.fresh);
        });
      }
    }

    it(`${op.type}: control (the verifiers' own) — CONFIRMED(C, R) observed in flight instead conflicts and holds`, async () => {
      const h = await submitted(op);
      backInFlightAfterReentry(h);
      h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_C, transactionId: ID_R, ...(op.credited === undefined ? {} : { credited: op.credited }) });
      expect(h.manager.operation("op")?.transactionHashes).toEqual([TX_A, TX_C]);
      expect(h.manager.operation("op")?.transactionIds).toEqual([ID_R]);
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
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
    async function approvalBackInFlight(): Promise<{ h: Harness; first: string }> {
      const h = harness();
      expect(h.manager.plan(plan).ok).toBe(true);
      await h.manager.submit("ap");
      const first = backInFlightAfterReentry(h, "ap");
      return { h, first };
    }

    for (const stale of STALE_VARIANTS) {
      for (const outcome of ["CONFIRMED", "FAILED"] as const) {
        const read = (requestId: string) => auth(outcome, stale.hash(outcome), stale.id, requestId);

        it(`${standard}: a superseded ${outcome} naming ${stale.label} in flight, then a current CONFIRMED(A): never ready after a sync`, async () => {
          const { h, first } = await approvalBackInFlight();
          expect(code(h.manager.resolveByReconciliation("ap", read(first)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
          expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
          sync(h);
          expect(ready(h)).toBe(false);
          expect(h.manager.operation("ap")?.state).toBe("RECONCILING");
          expect(h.manager.operation("ap")?.unresolvedTransactions).toEqual(stale.fresh);
        });

        it(`${standard}: the same superseded ${outcome} naming ${stale.label}, answered CONFIRMED(A) synchronously inside the request: never ready`, async () => {
          const { h, first } = await approvalBackInFlight();
          h.reconciler.onRequest = (request) => {
            h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, request.requestId));
          };
          expect(code(h.manager.resolveByReconciliation("ap", read(first)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
          h.reconciler.onRequest = undefined;
          sync(h);
          expect(ready(h)).toBe(false);
          expect(h.manager.operation("ap")?.state).toBe("RECONCILING");
          expect(h.manager.operation("ap")?.unresolvedTransactions).toEqual(stale.fresh);
        });

        it(`${standard}: control — the same ${outcome} naming ${stale.label} observed back under reconciliation: never ready`, async () => {
          const { h } = await approvalBackInFlight();
          h.manager.observe("ap", { status: "UNKNOWN" });
          h.manager.observe("ap", { status: outcome, transactionHash: stale.hash(outcome), transactionId: stale.id });
          expect(code(h.manager.resolveByReconciliation("ap", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
          sync(h);
          expect(ready(h)).toBe(false);
          expect(h.manager.operation("ap")?.unresolvedTransactions).toEqual(stale.fresh);
        });
      }
    }
  }
});

describe("WP300-R8-01: the other triggers of the same refusal (unknown request, unbound answer, the second verifier's sequence)", () => {
  for (const op of VALUE_OPS) {
    it(`${op.type}: an answer naming a request not issued for the operation, in flight, is weighed: FAILED(A) then releases nothing`, async () => {
      const h = await submitted(op);
      const foreign = auth("CONFIRMED", TX_C, ID_R, "wallet-op:other:reconciliation:1", op.credited);
      expect(code(h.manager.resolveByReconciliation("op", foreign))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expect(h.manager.operation("op")?.transactionHashes).toEqual([TX_A, TX_C]);
      expect(h.manager.operation("op")?.transactionIds).toEqual([ID_R]);
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_C), idKey(ID_R)]);
    });

    it(`${op.type}: an unbound answer in flight after a re-entry is weighed: FAILED(A) then releases nothing`, async () => {
      const h = await submitted(op);
      backInFlightAfterReentry(h);
      const unbound = auth("CONFIRMED", TX_C, null, undefined, op.credited);
      expect(code(h.manager.resolveByReconciliation("op", unbound))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_C)]);
    });

    it(`${op.type}: the second verifier's sequence (unrecognised executor result, DROPPED, SUBMITTED(A), the delayed CONFIRMED(B) for request 1, FAILED(A)) releases nothing`, async () => {
      const h = await submitted(op, () => Promise.resolve({ status: "???" }));
      const delayed = auth("CONFIRMED", TX_B, null, h.reconciler.id(1), op.credited);
      h.manager.observe("op", { status: "DROPPED" });
      // Since WP300-R8-02 the "still in flight" answer is refused here (the DROPPED
      // above was weighed under reconciliation) and weighed; on 457cede it returned
      // the operation to flight, where the delayed read was then dropped.
      h.manager.resolveByReconciliation("op", auth("SUBMITTED", TX_A, null, h.reconciler.latest()));
      h.manager.resolveByReconciliation("op", delayed);
      h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest()));
      expect(h.manager.operation("op")?.transactionHashes).toEqual([TX_A, TX_B]);
      expectHeld(h, op);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_B)]);
    });

    it(`${op.type}: control — the second verifier's sequence with the delayed fact observed instead`, async () => {
      const h = await submitted(op, () => Promise.resolve({ status: "???" }));
      h.manager.observe("op", { status: "DROPPED" });
      h.manager.resolveByReconciliation("op", auth("SUBMITTED", TX_A, null, h.reconciler.latest()));
      h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_B, transactionId: null, ...(op.credited === undefined ? {} : { credited: op.credited }) });
      h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest()));
      expectHeld(h, op);
    });
  }

  it("the weighing precedes the request: the request raised by the superseded answer carries the identity set it created", async () => {
    const h = await submitted(SPLIT);
    const first = backInFlightAfterReentry(h);
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_C, ID_R, first)))).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
    const request = h.reconciler.requests.at(-1);
    expect(request?.transactionHashes).toEqual([TX_A, TX_C]);
    expect(request?.transactionIds).toEqual([ID_R]);
    expect(request?.unresolvedTransactions).toEqual([hashKey(TX_A), hashKey(TX_C), idKey(ID_R)]);
    // A current answer to that request is accepted (the weighing did not supersede it).
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, request?.requestId)))).toBe("ok");
  });

  it("control: a CURRENT refused answer in flight is still applied like the same observation (the in-flight trust boundary)", async () => {
    const h = await submitted(SPLIT);
    // Amended in r9 (setup only): reconciliation is entered by a stale SUBMITTED after MINED, which weighs
    // nothing — since WP300-R9-01 a DROPPED that sends the operation back is weighed and ends simple mode.
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
    h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    expect(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe(
      "WALLET_OP_ILLEGAL_TRANSITION",
    );
    expect(h.manager.operation("op")?.state).toBe("FAILED");
    expect(wholeBalanceReservable(h, SPLIT)).toBe(true);
  });
});

// ------------------------------------------------------------------ R8-02 --

describe("WP300-R8-02: evidence weighed under reconciliation ends simple mode even while the identity set is empty", () => {
  /** An executor whose answer the test releases later. */
  function pendingExecutor(): { submit: () => Promise<unknown>; answer: (value: unknown) => void } {
    let resolve: (value: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((r) => {
      resolve = r;
    });
    return { submit: () => promise, answer: (value) => resolve(value) };
  }

  const WEIGHED: readonly { readonly label: string; readonly observation: Readonly<Record<string, unknown>> }[] = [
    { label: "an unnamed FAILED", observation: { status: "FAILED" } },
    { label: "an unnamed CONFIRMED (unrecognised)", observation: { status: "CONFIRMED" } },
    { label: "an unnamed MINED (unrecognised)", observation: { status: "MINED" } },
    { label: "a DROPPED", observation: { status: "DROPPED" } },
  ];

  for (const weighed of WEIGHED) {
    it(`the verifier's sequence with ${weighed.label}: the late SUBMITTED(A, R) opens both; FAILED(null, R) does not conclude for A`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      expect(h.manager.plan({ ...SPLIT.plan, operationId: "op", accountRef: ACCOUNT }).ok).toBe(true);
      const submitting = h.manager.submit("op");
      // DROPPED during submission: UNKNOWN at once, then RECONCILING (request 1); the set is empty.
      h.manager.observe("op", { status: "DROPPED" });
      expect(h.manager.operation("op")?.state).toBe("RECONCILING");
      // Evidence weighed under reconciliation while nothing has been named.
      h.manager.observe("op", weighed.observation);
      expect(h.manager.operation("op")?.transactionHashes).toEqual([]);
      const before = h.reconciler.requests.length;
      // The executor's late answer names A and R.
      executor.answer({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R });
      await submitting;
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
      // The reconciler is told: a request carries both.
      expect(h.reconciler.requests.length).toBe(before + 1);
      expect(h.reconciler.requests.at(-1)?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
      // FAILED(null, R), current and authoritative, answers R only.
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, SPLIT);
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A)]);
      // A answered by name concludes.
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      expect(h.manager.operation("op")?.state).toBe("FAILED");
    });
  }

  it("the answer route: after the empty-set weighing, an authoritative SUBMITTED(A, R) is refused (not terminal) and weighed: both must be answered", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "???" }));
    h.manager.observe("op", { status: "DROPPED" });
    expect(code(h.manager.resolveByReconciliation("op", auth("SUBMITTED", TX_A, ID_R, h.reconciler.latest())))).toBe(
      "WALLET_OP_EVIDENCE_REQUIRED",
    );
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
    expectHeld(h, SPLIT);
  });

  for (const late of [{ status: "NOT_SENT" }, { status: "???" }] as const) {
    it(`a late contradiction from the executor (${late.status}) is weighed under reconciliation: simple mode ends, FAILED(null, R) does not conclude for A`, async () => {
      const executor = pendingExecutor();
      const h = harness(executor.submit);
      expect(h.manager.plan({ ...SPLIT.plan, operationId: "op", accountRef: ACCOUNT }).ok).toBe(true);
      const submitting = h.manager.submit("op");
      // An unrecognised observation naming A and R during submission: UNKNOWN, then RECONCILING.
      h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A, transactionId: ID_R });
      // Amended in r9: since WP300-R9-01 that DROPPED is itself weighed when it sends the operation back
      // (it was "simple mode" here in r8), so both members are required at once; the late contradiction
      // is then weighed too and changes nothing about that.
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
      executor.answer(late);
      await submitting;
      expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([hashKey(TX_A), idKey(ID_R)]);
      expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
      expectHeld(h, SPLIT);
    });
  }

  it("control (liveness): with no member at all, a terminal answer naming no transaction still concludes", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "???" }));
    h.manager.observe("op", { status: "DROPPED" });
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([]);
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
    expect(wholeBalanceReservable(h, SPLIT)).toBe(true);
  });

  it("control (liveness): with no member at all, a terminal answer naming the transaction concludes and admits it", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "???" }));
    h.manager.observe("op", { status: "DROPPED" });
    expect(code(h.manager.resolveByReconciliation("op", auth("CONFIRMED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("CONFIRMED");
    expect(h.manager.operation("op")?.transactionHashes).toEqual([TX_A]);
  });

  it("control (the stated exception): a stale SUBMITTED/MINED report naming no new member changes nothing — simple mode stays", async () => {
    const h = await submitted(SPLIT);
    // Amended in r9 (setup only): reconciliation is entered by a stale SUBMITTED after MINED, which weighs
    // nothing — since WP300-R9-01 a DROPPED that sends the operation back is weighed and ends simple mode.
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
    h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    const requests = h.reconciler.requests.length;
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
    expect(h.reconciler.requests).toHaveLength(requests);
    expect(h.manager.operation("op")?.unresolvedTransactions).toEqual([]);
    // "Still in flight" is still accepted: the operation returns to flight.
    expect(code(h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("MINED");
  });

  it("control: simple mode (nothing weighed under reconciliation) still concludes on one member — the disclosed pairing", async () => {
    const h = await submitted(SPLIT, () => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R }));
    // Amended in r9 (setup only): reconciliation is entered by a stale SUBMITTED after MINED, which weighs
    // nothing — since WP300-R9-01 an UNKNOWN that sends the operation back is weighed and ends simple mode.
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
    h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R });
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", null, ID_R, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });
});

// ------------------------------------------------------------------ R8-X1 --

describe("WP300-R8-X1: an operation sent back to UNKNOWN during a synchronous delivery keeps the newer request", () => {
  it("answered in flight and sent back inside the call: it stays UNKNOWN, and retry delivers the request that carries the new evidence", async () => {
    const h = await submitted(SPLIT);
    // Amended in r9 (setup only): reconciliation is entered by a stale SUBMITTED after MINED, which weighs
    // nothing — since WP300-R9-01 a DROPPED that sends the operation back is weighed and ends simple mode,
    // so the synchronous "still in flight" answer below would be refused.
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A });
    let calls = 0;
    h.reconciler.onRequest = (request) => {
      calls += 1;
      if (calls > 1) return;
      // "Still in flight" for the request, then a lifecycle observer reports UNKNOWN naming C, synchronously.
      h.manager.resolveByReconciliation("op", auth("MINED", TX_A, null, request.requestId));
      h.manager.observe("op", { status: "UNKNOWN", transactionHash: TX_C });
    };
    h.manager.observe("op", { status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    expect(h.manager.operation("op")?.state).toBe("UNKNOWN");
    expect(h.reconciler.requests).toHaveLength(1);
    expect(h.manager.retryReconciliationRequests()).toBe(1);
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expect(h.reconciler.requests).toHaveLength(2);
    expect(h.reconciler.requests.at(-1)?.transactionHashes).toEqual([TX_A, TX_C]);
    // The delivered request is current: an answer to it is accepted.
    expect(code(h.manager.resolveByReconciliation("op", auth("FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expectHeld(h, SPLIT);
  });
});
