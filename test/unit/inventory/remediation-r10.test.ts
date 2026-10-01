/**
 * WP-300b: pins for WP300-R10-01 (LOW), found by the WP-300 round-10 verifiers.
 *
 * A TERMINAL reconciliation answer bound to a request never issued for the
 * operation — another operation's real request, an unknown id — from the
 * authority or the relayer, delivered while the executor call was pending and
 * the operation was still PLANNED, was refused `WALLET_OP_ILLEGAL_TRANSITION`,
 * KEPT like an observation, and applied once the executor answered SUBMITTED:
 * the operation concluded FAILED with no reconciliation request and its
 * reservation released, or, for an ERC20/ERC1155 approval, concluded CONFIRMED
 * and was ready after a CLOB allowance sync. The same answer delivered in flight
 * was refused `WALLET_OP_EVIDENCE_SUPERSEDED` and held.
 *
 * The fix routes it as the in-flight answer is routed: refused
 * `WALLET_OP_EVIDENCE_SUPERSEDED`, never kept, the operation sent to
 * reconciliation and the answer weighed there (with whatever was kept before
 * it) before the request is delivered. No reconciliation request has been
 * issued while an operation is PLANNED, so any request it names is not one of
 * its own.
 *
 * "The probe" below is the round-10 probe, case by case (11 cases): the six
 * defect cases fail against the base (`2740658`); the five contrasts and
 * controls (an answer naming no request, the observe() control, and the three
 * in-flight cases) pin behaviour that does not change, and pass on both. The
 * grid then covers every value type and both approval standards, every
 * terminal shape, five bindings and three sources; it fails against the base
 * too. Controls and guards are marked as such.
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
const ID_R = "sanitized-relayer-id-r";

const hashKey = (hash: string): string => `hash:${hash}`;
const idKey = (id: string): string => `id:${id}`;

const code = (result: { ok: boolean; refusal?: { code: string } }) => (result.ok ? "ok" : result.refusal?.code);

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  failing = false;
  onRequest: ((request: ReconciliationRequest) => void) | undefined;
  request(request: ReconciliationRequest): void {
    if (this.failing) throw new Error("reconciler unavailable");
    this.requests.push(request);
    this.onRequest?.(request);
  }
  for(operationId: string): string[] {
    return this.requests.filter((request) => request.walletOperationId === operationId).map((request) => request.requestId);
  }
  latest(operationId = "op"): string {
    const id = this.for(operationId).at(-1);
    if (id === undefined) throw new Error(`no request for ${operationId}`);
    return id;
  }
}

/**
 * "op" waits on a pending executor call (or answers SUBMITTED at once when
 * `immediate`); "op2", a WRAP on USDC.e that never touches the assets "op"
 * reserves, answers "???" so it goes UNKNOWN and gets a REAL reconciliation
 * request — a request issued for ANOTHER operation (the probe's setup).
 */
function harness(options: { readonly immediate?: boolean; readonly answer?: Readonly<Record<string, unknown>> } = {}) {
  const book = seededBook({ [PUSD]: "100", [YES]: "20", [NO]: "20", [USDC_E]: "50" });
  const reconciler = new Reconciler();
  const approvals = new ApprovalTracker();
  const submitted = options.answer ?? { status: "SUBMITTED", transactionHash: TX_A, transactionId: null };
  let release: (value: unknown) => void = () => undefined;
  const executor: WalletOperationExecutor = {
    submit: (submission) =>
      submission.operationId === "op2"
        ? Promise.resolve({ status: "???" })
        : options.immediate === true
          ? Promise.resolve(submitted)
          : new Promise<unknown>((resolve) => {
              release = resolve;
            }),
  };
  const manager = new WalletOperationManager({ requestToken: requestTokens(), book, approvals, executor, reconciler });
  return { book, reconciler, approvals, manager, release: (value: unknown = submitted) => release(value) };
}

type Harness = ReturnType<typeof harness>;

/** The id of a real request issued for ANOTHER operation ("op2"). */
async function otherOperationsRequest(h: Harness): Promise<string> {
  expect(h.manager.plan({ type: "WRAP_COLLATERAL", operationId: "op2", accountRef: ACCOUNT, amount: "10" }).ok).toBe(true);
  await h.manager.submit("op2");
  expect(h.manager.operation("op2")?.state).toBe("RECONCILING");
  return h.reconciler.latest("op2");
}

/** A reconciliation answer; `requestId` is the request it claims to report a read for (absent: none named). */
const answer = (
  source: string,
  state: string,
  transactionHash: string | null,
  transactionId: string | null,
  requestId?: unknown,
  credited?: string,
) => ({
  source,
  state,
  transactionHash,
  transactionId,
  ...(requestId === undefined ? {} : { requestId }),
  ...(credited === undefined ? {} : { credited }),
});

/** Whether `amount` of `asset` can be reserved now (reserved and released at once). */
function reservable(h: Harness, asset: string, amount: string): string {
  const result = h.book.reserve({ reservationId: "probe-all", holderRef: "probe-holder", accountRef: ACCOUNT, assetId: asset, amount });
  if (result.ok) h.book.release({ reservationId: "probe-all" });
  return result.ok ? "ok" : result.refusal.code;
}

const SPLIT_PLAN = { type: "SPLIT", operationId: "op", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" };

// ------------------------------------------------------------ the probe --

describe("WP300-R10-01: the round-10 probe, case by case", () => {
  const defects = [
    { label: "AUTH FAILED(A) bound to op2's real request", source: "AUTHORITATIVE_READ", hash: TX_A, binding: "real" },
    { label: "AUTH FAILED(null) bound to op2's real request", source: "AUTHORITATIVE_READ", hash: null, binding: "real" },
    { label: "AUTH FAILED(A) bound to an unknown id", source: "AUTHORITATIVE_READ", hash: TX_A, binding: "a-request-of-another-operation" },
    { label: "RELAYER FAILED(A) bound to op2's real request", source: "RELAYER_STATUS", hash: TX_A, binding: "real" },
  ] as const;

  for (const v of defects) {
    it(`PLANNED ${v.label}: refused as superseded, sent to reconciliation, never applied; the reservation stays held`, async () => {
      const h = harness();
      const r2 = await otherOperationsRequest(h);
      expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
      const submitting = h.manager.submit("op");
      const binding = v.binding === "real" ? r2 : v.binding;
      // The decisive step: the answer arrives while the executor call is pending and the operation is PLANNED.
      expect(code(h.manager.resolveByReconciliation("op", answer(v.source, "FAILED", v.hash, null, binding)))).toBe(
        "WALLET_OP_EVIDENCE_SUPERSEDED",
      );
      expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", submitting: true, bufferedObservations: 0 });
      expect(h.reconciler.for("op")).toHaveLength(1);
      h.release();
      await submitting;
      expect(h.manager.operation("op")).toMatchObject({
        state: "RECONCILING",
        submitting: false,
        bufferedObservations: 0,
        transactionHashes: [TX_A],
        unresolvedTransactions: [hashKey(TX_A)],
        effectsApplied: false,
      });
      // FAILED(null) named nothing: the executor's late SUBMITTED(A) opens A, and a fresh request carries it.
      expect(h.reconciler.for("op")).toHaveLength(v.hash === null ? 2 : 1);
      expect(h.book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
      expect(reservable(h, PUSD, "100")).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
      // Liveness: a current answer naming A concludes.
      expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
      expect(h.manager.operation("op")?.state).toBe("FAILED");
      expect(reservable(h, PUSD, "100")).toBe("ok");
    });
  }

  it("control (unchanged): PLANNED AUTH FAILED(A) naming NO request is current and kept like the same observation; it concludes after SUBMITTED", async () => {
    const h = harness();
    await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    const submitting = h.manager.submit("op");
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null)))).toBe(
      "WALLET_OP_ILLEGAL_TRANSITION",
    );
    expect(h.manager.operation("op")).toMatchObject({ state: "PLANNED", submitting: true, bufferedObservations: 1 });
    h.release();
    await submitting;
    expect(h.manager.operation("op")).toMatchObject({ state: "FAILED", bufferedObservations: 0 });
    expect(h.reconciler.for("op")).toHaveLength(0);
    expect(reservable(h, PUSD, "100")).toBe("ok");
  });

  it("control (unchanged): the observe() control — FAILED(A) observed while PLANNED is kept and concludes after SUBMITTED (the in-flight trust boundary)", async () => {
    const h = harness();
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    const submitting = h.manager.submit("op");
    expect(code(h.manager.observe("op", { status: "FAILED", transactionHash: TX_A, transactionId: null }))).toBe("ok");
    expect(h.manager.operation("op")).toMatchObject({ state: "PLANNED", submitting: true, bufferedObservations: 1 });
    h.release();
    await submitting;
    expect(h.manager.operation("op")?.state).toBe("FAILED");
    expect(h.reconciler.for("op")).toHaveLength(0);
    expect(reservable(h, PUSD, "100")).toBe("ok");
  });

  it("control (unchanged): in flight, AUTH FAILED(A) bound to op2's real request is superseded and the reservation stays held", async () => {
    const h = harness({ immediate: true });
    const r2 = await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    await h.manager.submit("op");
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, r2)))).toBe(
      "WALLET_OP_EVIDENCE_SUPERSEDED",
    );
    expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [hashKey(TX_A)] });
    expect(h.reconciler.for("op")).toHaveLength(1);
    expect(reservable(h, PUSD, "100")).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
  });

  for (const standard of ["ERC20", "ERC1155"] as const) {
    const plan =
      standard === "ERC20"
        ? { type: "APPROVE_ERC20", operationId: "op", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" }
        : { type: "APPROVE_ERC1155", operationId: "op", accountRef: ACCOUNT, spender: CTF_EXCHANGE };
    const ready = (h: Harness): boolean =>
      standard === "ERC20"
        ? h.approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE]).ready
        : h.approvals.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready;
    const sync = (h: Harness): void =>
      standard === "ERC20"
        ? h.approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" })
        : h.approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });

    it(`approval ${standard}: PLANNED, CONFIRMED(A) bound to op2's real request is never applied; not ready after a sync`, async () => {
      const h = harness();
      const r2 = await otherOperationsRequest(h);
      expect(h.manager.plan(plan).ok).toBe(true);
      const submitting = h.manager.submit("op");
      expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "CONFIRMED", TX_A, null, r2)))).toBe(
        "WALLET_OP_EVIDENCE_SUPERSEDED",
      );
      expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", submitting: true, bufferedObservations: 0 });
      h.release();
      await submitting;
      expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [hashKey(TX_A)] });
      sync(h);
      expect(ready(h)).toBe(false);
      expect(h.approvals.approvalStatus("op")).toBe("NONE");
      expect(h.reconciler.for("op")).toHaveLength(1);
      // Liveness: a current CONFIRMED(A), then a sync recorded after it, makes it ready.
      expect(
        code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "CONFIRMED", TX_A, null, h.reconciler.latest()))),
      ).toBe("ok");
      expect(h.manager.operation("op")?.state).toBe("CONFIRMED");
      expect(ready(h)).toBe(false);
      sync(h);
      expect(ready(h)).toBe(true);
    });

    it(`control (unchanged): approval ${standard} in flight, CONFIRMED(A) bound to op2's real request is superseded; not ready after a sync`, async () => {
      const h = harness({ immediate: true });
      const r2 = await otherOperationsRequest(h);
      expect(h.manager.plan(plan).ok).toBe(true);
      await h.manager.submit("op");
      expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "CONFIRMED", TX_A, null, r2)))).toBe(
        "WALLET_OP_EVIDENCE_SUPERSEDED",
      );
      expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [hashKey(TX_A)] });
      sync(h);
      expect(ready(h)).toBe(false);
      expect(h.reconciler.for("op")).toHaveLength(1);
    });
  }
});

// ------------------------------------------------------------- the grid --

interface ValueOp {
  readonly type: string;
  readonly plan: Readonly<Record<string, unknown>>;
  /** The asset the operation reserves, how much of it, and the account's whole balance of it. */
  readonly asset: string;
  readonly amount: string;
  readonly balance: string;
  /** What the line's `reserved` reads while the operation holds its reservation (op2's included). */
  readonly reservedTotal: string;
  /** A CONFIRMED for this type carries the observed credited amount. */
  readonly credited: string | undefined;
}

const VALUE_OPS: readonly ValueOp[] = [
  { type: "SPLIT", plan: { type: "SPLIT", conditionId: CONDITION, amount: "10" }, asset: PUSD, amount: "10", balance: "100", reservedTotal: "10", credited: undefined },
  { type: "MERGE", plan: { type: "MERGE", conditionId: CONDITION, amount: "5" }, asset: YES, amount: "5", balance: "20", reservedTotal: "5", credited: undefined },
  {
    type: "REDEEM",
    plan: { type: "REDEEM", conditionId: CONDITION, resolution: "YES_WIN", yesAmount: "5" },
    asset: YES,
    amount: "5",
    balance: "20",
    reservedTotal: "5",
    credited: "5",
  },
  // op2 also wraps (and holds) 10 USDC.e: the whole-balance check uses what is left, and `reserved` includes op2's.
  {
    type: "WRAP_COLLATERAL",
    plan: { type: "WRAP_COLLATERAL", amount: "10" },
    asset: USDC_E,
    amount: "10",
    balance: "40",
    reservedTotal: "20",
    credited: "10",
  },
  {
    type: "UNWRAP_COLLATERAL",
    plan: { type: "UNWRAP_COLLATERAL", amount: "10" },
    asset: PUSD,
    amount: "10",
    balance: "100",
    reservedTotal: "10",
    credited: "10",
  },
];

/** A terminal answer's shape: what it says and names. */
interface Shape {
  readonly label: string;
  readonly state: "FAILED" | "CONFIRMED";
  readonly hash: string | null;
  readonly id: string | null;
}

const SHAPES: readonly Shape[] = [
  { label: "FAILED(A)", state: "FAILED", hash: TX_A, id: null },
  { label: "FAILED(null)", state: "FAILED", hash: null, id: null },
  { label: "FAILED(null, R)", state: "FAILED", hash: null, id: ID_R },
  { label: "CONFIRMED(A)", state: "CONFIRMED", hash: TX_A, id: null },
  { label: "CONFIRMED(A, R)", state: "CONFIRMED", hash: TX_A, id: ID_R },
];

/** Bindings that name a request never issued for "op" (none has been, while it is PLANNED). */
const BINDINGS: readonly { readonly label: string; readonly of: (r2: string) => unknown }[] = [
  { label: "op2's real request", of: (r2) => r2 },
  { label: "a foreign id", of: () => "wallet-op:foreign:reconciliation:1" },
  { label: "an unknown id", of: () => "a-request-of-another-operation" },
  { label: "an empty id", of: () => "" },
  { label: "a malformed (numeric) id", of: () => 7 },
];

const SOURCES = ["AUTHORITATIVE_READ", "RELAYER_STATUS", "HEARSAY"] as const;

describe("WP300-R10-01 grid: while PLANNED with the executor pending, a terminal answer naming a request never issued is never applied", () => {
  for (const op of VALUE_OPS) {
    for (const shape of SHAPES) {
      it(`${op.type}: ${shape.label}, for every binding and source — superseded, weighed, held; then concluded by name`, async () => {
        for (const binding of BINDINGS) {
          for (const source of SOURCES) {
            const label = `${op.type} ${source} ${shape.label} bound to ${binding.label}`;
            const h = harness({ answer: { status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R } });
            const r2 = await otherOperationsRequest(h);
            expect(h.manager.plan({ ...op.plan, operationId: "op", accountRef: ACCOUNT }).ok, label).toBe(true);
            const before = { [PUSD]: h.book.line(ACCOUNT, PUSD)?.actual, [YES]: h.book.line(ACCOUNT, YES)?.actual, [USDC_E]: h.book.line(ACCOUNT, USDC_E)?.actual };
            const submitting = h.manager.submit("op");
            const credited = shape.state === "CONFIRMED" ? op.credited : undefined;
            const result = h.manager.resolveByReconciliation("op", answer(source, shape.state, shape.hash, shape.id, binding.of(r2), credited));
            expect(code(result), label).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
            expect(h.manager.operation("op")?.state, label).toBe("RECONCILING");
            expect(h.manager.operation("op")?.bufferedObservations, label).toBe(0);
            h.release();
            await submitting;
            const view = h.manager.operation("op");
            expect(view?.state, label).toBe("RECONCILING");
            expect(view?.effectsApplied, label).toBe(false);
            // Every member is answered by name: the answer's own and the executor's (A, R).
            expect(view?.unresolvedTransactions, label).toEqual([hashKey(TX_A), idKey(ID_R)]);
            expect(h.book.line(ACCOUNT, op.asset)?.reserved, label).toBe(op.reservedTotal);
            for (const reservationId of view?.reservationIds ?? []) {
              expect(h.book.reservation(reservationId), label).toMatchObject({ status: "ACTIVE", remaining: op.amount });
            }
            expect(reservable(h, op.asset, op.balance), label).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
            expect(h.book.line(ACCOUNT, PUSD)?.actual, label).toBe(before[PUSD]);
            expect(h.book.line(ACCOUNT, YES)?.actual, label).toBe(before[YES]);
            expect(h.book.line(ACCOUNT, USDC_E)?.actual, label).toBe(before[USDC_E]);
            // One member answered is not enough (no pairing is assumed once the answer was weighed).
            expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, h.reconciler.latest()))), label).toBe("ok");
            expect(h.manager.operation("op")?.state, label).toBe("RECONCILING");
            expect(reservable(h, op.asset, op.balance), label).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
            // Liveness: the last member by name concludes and releases.
            expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", null, ID_R, h.reconciler.latest()))), label).toBe("ok");
            expect(h.manager.operation("op")?.state, label).toBe("FAILED");
            expect(reservable(h, op.asset, op.balance), label).toBe("ok");
          }
        }
      });
    }
  }

  for (const standard of ["ERC20", "ERC1155"] as const) {
    const plan =
      standard === "ERC20"
        ? { type: "APPROVE_ERC20", operationId: "op", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" }
        : { type: "APPROVE_ERC1155", operationId: "op", accountRef: ACCOUNT, spender: CTF_EXCHANGE };
    const ready = (h: Harness): boolean =>
      standard === "ERC20"
        ? h.approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE]).ready
        : h.approvals.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready;
    const sync = (h: Harness): void =>
      standard === "ERC20"
        ? h.approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" })
        : h.approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });

    for (const shape of SHAPES) {
      it(`${standard}: ${shape.label}, for every binding and source — never recorded or ready after a sync; then ready only by name`, async () => {
        for (const binding of BINDINGS) {
          for (const source of SOURCES) {
            const label = `${standard} ${source} ${shape.label} bound to ${binding.label}`;
            const h = harness({ answer: { status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R } });
            const r2 = await otherOperationsRequest(h);
            expect(h.manager.plan(plan).ok, label).toBe(true);
            const submitting = h.manager.submit("op");
            const result = h.manager.resolveByReconciliation("op", answer(source, shape.state, shape.hash, shape.id, binding.of(r2)));
            expect(code(result), label).toBe("WALLET_OP_EVIDENCE_SUPERSEDED");
            h.release();
            await submitting;
            expect(h.manager.operation("op")?.state, label).toBe("RECONCILING");
            expect(h.manager.operation("op")?.unresolvedTransactions, label).toEqual([hashKey(TX_A), idKey(ID_R)]);
            sync(h);
            expect(ready(h), label).toBe(false);
            expect(h.approvals.approvalStatus("op"), label).toBe("NONE");
            // A current CONFIRMED for one member is not enough; both by name, then a sync after it.
            expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "CONFIRMED", TX_A, null, h.reconciler.latest()))), label).toBe("ok");
            sync(h);
            expect(ready(h), label).toBe(false);
            expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "CONFIRMED", TX_A, ID_R, h.reconciler.latest()))), label).toBe("ok");
            expect(h.manager.operation("op")?.state, label).toBe("CONFIRMED");
            expect(ready(h), label).toBe(false);
            sync(h);
            expect(ready(h), label).toBe(true);
          }
        }
      });
    }
  }
});

// --------------------------------------------------- around the routing --

describe("WP300-R10-01: what goes with the answer, and what does not change", () => {
  it("observations kept before it are weighed with it, never applied: a kept CONFIRMED(A) does not conclude", async () => {
    const h = harness({ answer: { status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_R } });
    const r2 = await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    const submitting = h.manager.submit("op");
    h.manager.observe("op", { status: "MINED", transactionHash: TX_A, transactionId: ID_R });
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: ID_R });
    expect(h.manager.operation("op")?.bufferedObservations).toBe(2);
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_B, null, r2)))).toBe(
      "WALLET_OP_EVIDENCE_SUPERSEDED",
    );
    // Both kept observations and the answer are weighed: A, R and the answer's B must each be answered by name.
    expect(h.manager.operation("op")).toMatchObject({
      state: "RECONCILING",
      bufferedObservations: 0,
      transactionHashes: [TX_A, TX_B],
      transactionIds: [ID_R],
      unresolvedTransactions: [hashKey(TX_A), hashKey(TX_B), idKey(ID_R)],
      effectsApplied: false,
    });
    expect(h.reconciler.for("op")).toHaveLength(1);
    expect(h.reconciler.requests.at(-1)?.unresolvedTransactions).toEqual([hashKey(TX_A), hashKey(TX_B), idKey(ID_R)]);
    h.release();
    await submitting;
    expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", effectsApplied: false });
    expect(h.book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
    expect(h.book.line(ACCOUNT, YES)?.actual).toBe("20");
  });

  it("a synchronous reconciler answering its fresh request while the executor is still pending is refused and asked again once the executor answers", async () => {
    const h = harness();
    const r2 = await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    const submitting = h.manager.submit("op");
    const inside: string[] = [];
    h.reconciler.onRequest = (request) => {
      if (request.walletOperationId !== "op") return;
      h.reconciler.onRequest = undefined;
      inside.push(String(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, request.requestId)))));
    };
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, r2)))).toBe(
      "WALLET_OP_EVIDENCE_SUPERSEDED",
    );
    // Nothing concludes while the executor call is pending (WP300-R3-02).
    expect(inside).toEqual(["WALLET_OP_EVIDENCE_REQUIRED"]);
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expect(h.reconciler.for("op")).toHaveLength(1);
    h.release();
    await submitting;
    // The request owed is sent once the executor answers, and a current answer to it concludes.
    expect(h.reconciler.for("op")).toHaveLength(2);
    expect(reservable(h, PUSD, "100")).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
    expect(reservable(h, PUSD, "100")).toBe("ok");
  });

  it("with the reconciler down the operation stays UNKNOWN, request queued; retry moves it to RECONCILING; nothing is released meanwhile", async () => {
    const h = harness();
    const r2 = await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    const submitting = h.manager.submit("op");
    h.reconciler.failing = true;
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, r2)))).toBe(
      "WALLET_OP_EVIDENCE_SUPERSEDED",
    );
    expect(h.manager.operation("op")?.state).toBe("UNKNOWN");
    h.release();
    await submitting;
    expect(h.manager.operation("op")?.state).toBe("UNKNOWN");
    expect(reservable(h, PUSD, "100")).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
    h.reconciler.failing = false;
    expect(h.manager.retryReconciliationRequests()).toBeGreaterThan(0);
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, h.reconciler.latest())))).toBe("ok");
    expect(h.manager.operation("op")?.state).toBe("FAILED");
  });

  it("guard (unchanged): a NON-terminal answer naming a request never issued is kept like the same observation (it cannot conclude)", async () => {
    const h = harness();
    const r2 = await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    const submitting = h.manager.submit("op");
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "MINED", TX_A, null, r2)))).toBe(
      "WALLET_OP_ILLEGAL_TRANSITION",
    );
    expect(h.manager.operation("op")).toMatchObject({ state: "PLANNED", bufferedObservations: 1 });
    h.release();
    await submitting;
    expect(h.manager.operation("op")?.state).toBe("MINED");
    expect(h.book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
  });

  it("guard (unchanged): an unrecognised answer naming a request never issued sends the operation to reconciliation at once", async () => {
    const h = harness();
    const r2 = await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    const submitting = h.manager.submit("op");
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "NOT_FOUND", TX_A, null, r2)))).toBe(
      "WALLET_OP_ILLEGAL_TRANSITION",
    );
    expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", bufferedObservations: 0 });
    h.release();
    await submitting;
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expect(reservable(h, PUSD, "100")).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
  });

  it("guard (unchanged): before submission nothing has left the process; a terminal answer naming a request changes nothing", async () => {
    const h = harness({ immediate: true });
    const r2 = await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    for (const shape of SHAPES) {
      const result = h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", shape.state, shape.hash, shape.id, r2));
      expect(code(result), shape.label).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    }
    expect(h.manager.operation("op")).toMatchObject({
      state: "PLANNED",
      submitting: false,
      bufferedObservations: 0,
      transactionHashes: [],
      transactionIds: [],
    });
    expect(h.reconciler.for("op")).toHaveLength(0);
    // It is submitted and concludes on its own evidence.
    await h.manager.submit("op");
    h.manager.observe("op", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(h.manager.operation("op")?.state).toBe("CONFIRMED");
    expect(h.book.line(ACCOUNT, PUSD)?.actual).toBe("90");
  });

  it("guard: once the operation left PLANNED with the executor pending, an answer naming a request never issued is refused and weighed (never concluded)", async () => {
    const h = harness();
    const r2 = await otherOperationsRequest(h);
    expect(h.manager.plan(SPLIT_PLAN).ok).toBe(true);
    const submitting = h.manager.submit("op");
    h.manager.observe("op", { status: "DROPPED", transactionHash: TX_A });
    expect(h.manager.operation("op")?.state).toBe("RECONCILING");
    expect(code(h.manager.resolveByReconciliation("op", answer("AUTHORITATIVE_READ", "FAILED", TX_A, null, r2)))).toBe(
      "WALLET_OP_EVIDENCE_REQUIRED",
    );
    expect(code(h.manager.resolveByReconciliation("op", answer("RELAYER_STATUS", "CONFIRMED", TX_B, null, r2)))).toBe(
      "WALLET_OP_EVIDENCE_REQUIRED",
    );
    expect(h.manager.operation("op")?.transactionHashes).toEqual([TX_A, TX_B]);
    h.release();
    await submitting;
    expect(h.manager.operation("op")).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [hashKey(TX_A), hashKey(TX_B)] });
    expect(reservable(h, PUSD, "100")).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
  });
});
