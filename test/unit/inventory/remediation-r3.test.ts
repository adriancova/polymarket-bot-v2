/**
 * WP-300 remediation round 3: pins for the verifier's findings WP300-R3-01 and
 * WP300-R3-02. Each pin fails against the round-2 candidate (f1b1c0f) and
 * passes after the fix (controls are marked as such).
 *
 * All executors and reconcilers are in-memory mocks. Nothing is signed or sent.
 */

import { describe, expect, it } from "vitest";

import {
  ApprovalTracker,
  WalletOperationManager,
  type ReconciliationRequest,
  type WalletOperationExecutor,
  type WalletOperationSubmission,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, NO, PUSD, YES, seededBook } from "./helpers.js";

const TX_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const TX_B = "0x00000000000000000000000000000000000000000000000000000000000000b2";
const TX_C = "0x00000000000000000000000000000000000000000000000000000000000000c3";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

class ScriptedExecutor implements WalletOperationExecutor {
  constructor(readonly respond: (submission: WalletOperationSubmission) => Promise<unknown>) {}
  submit(submission: WalletOperationSubmission): Promise<unknown> {
    return this.respond(submission);
  }
}

function harness(respond: (s: WalletOperationSubmission) => Promise<unknown>) {
  const book = seededBook({ [PUSD]: "100" });
  const reconciler = new Reconciler();
  const manager = new WalletOperationManager({
    book,
    approvals: new ApprovalTracker(),
    executor: new ScriptedExecutor(respond),
    reconciler,
  });
  return { book, reconciler, manager };
}

/** A harness whose executor call stays pending until `answer` resolves. */
function pendingHarness() {
  const answer = deferred<unknown>();
  const h = harness(() => answer.promise);
  h.manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" });
  const submitting = h.manager.submit("s");
  return { ...h, answer, submitting };
}

const reserveAll = (book: ReturnType<typeof seededBook>, amount: string, id = "probe") =>
  book.reserve({ reservationId: id, holderRef: "probe-holder", accountRef: ACCOUNT, assetId: PUSD, amount });

const read = (book: ReturnType<typeof seededBook>, assetId: string, balance: string) =>
  book.observeActual({ accountRef: ACCOUNT, assetId, balance });

const authoritative = (state: string, transactionHash: string | null, transactionId: string | null = null) => ({
  source: "AUTHORITATIVE_READ",
  state,
  transactionHash,
  transactionId,
  requestId: latestRequestId,
});

// ----------------------------------------------------------------- R3-01 --

describe("WP300-R3-01: transaction identities named before UNKNOWN survive it and must all be resolved", () => {
  for (const first of [
    { status: "MINED", transactionHash: TX_A },
    { status: "CONFIRMED", transactionHash: TX_A, transactionId: null },
  ] as const) {
    it(`the verifier's reproduction with ${first.status}(A): FAILED(B) does not release while A is unresolved`, async () => {
      const { book, manager, reconciler, answer, submitting } = pendingHarness();
      manager.observe("s", first);
      manager.observe("s", { status: "UNKNOWN" });
      expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", transactionHash: TX_A, transactionHashes: [TX_A] });
      // The request itself carries the identity.
      expect(reconciler.requests[0]).toMatchObject({ transactionHashes: [TX_A] });

      answer.resolve({ status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
      await submitting;
      expect(manager.operation("s")).toMatchObject({
        state: "RECONCILING",
        transactionHashes: [TX_A, TX_B],
        unresolvedTransactions: [`hash:${TX_A}`, `hash:${TX_B}`],
      });
      expect(reconciler.requests.at(-1)).toMatchObject({ transactionHashes: [TX_A, TX_B] });

      const partial = manager.resolveByReconciliation("s", authoritative("FAILED", TX_B));
      expect(partial.ok && partial.value).toMatchObject({ state: "RECONCILING", unresolvedTransactions: [`hash:${TX_A}`] });
      expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
      expect(reserveAll(book, "100").ok).toBe(false);
      expect(read(book, PUSD, "100").ok).toBe(false); // still in flight

      // Only once A is resolved too does the operation conclude.
      expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)).ok).toBe(true);
      expect(manager.operation("s")).toMatchObject({ state: "FAILED", unresolvedTransactions: [] });
      expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
      expect(reserveAll(book, "100").ok).toBe(true);
    });
  }

  it("with conflicting transactions, one CONFIRMED among the resolutions concludes CONFIRMED (lines await a read)", async () => {
    const { book, manager, answer, submitting } = pendingHarness();
    manager.observe("s", { status: "MINED", transactionHash: TX_A });
    manager.observe("s", { status: "UNKNOWN" });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    await submitting;
    expect(manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A)).ok).toBe(true);
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)).ok).toBe(true);
    expect(manager.operation("s")).toMatchObject({ state: "CONFIRMED", effectsApplied: false });
    for (const asset of [PUSD, YES, NO]) expect(book.line(ACCOUNT, asset)?.blocked).toBe("AWAITING_OBSERVATION");
    expect(reserveAll(book, "90").ok).toBe(false);
  });

  it("a conflicted operation refuses unnamed, in-flight, unwitnessed and contradictory resolutions", async () => {
    const { book, manager, answer, submitting } = pendingHarness();
    manager.observe("s", { status: "MINED", transactionHash: TX_A });
    manager.observe("s", { status: "UNKNOWN" });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    await submitting;
    const cases: readonly [unknown, string][] = [
      [authoritative("FAILED", null), "WALLET_OP_EVIDENCE_REQUIRED"],
      [authoritative("MINED", TX_A), "WALLET_OP_EVIDENCE_REQUIRED"],
      [authoritative("FAILED", TX_C), "WALLET_OP_EVIDENCE_CONFLICT"],
    ];
    for (const [evidence, code] of cases) {
      const refused = manager.resolveByReconciliation("s", evidence);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe(code);
    }
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)).ok).toBe(true);
    const flipped = manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A));
    expect(flipped.ok).toBe(false);
    if (!flipped.ok) expect(flipped.refusal.code).toBe("WALLET_OP_EVIDENCE_CONFLICT");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
  });

  it("an unrecognised observation naming a transaction during submission is witnessed too", async () => {
    const { book, manager, answer, submitting } = pendingHarness();
    manager.observe("s", { status: "DROPPED", transactionHash: TX_A });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    await submitting;
    expect(manager.operation("s")?.transactionHashes).toEqual([TX_A, TX_B]);
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)).ok).toBe(true);
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
  });

  it("an observation naming a transaction while RECONCILING is refused but witnessed: FAILED(other) no longer releases", async () => {
    const { book, manager, reconciler } = harness(() => Promise.resolve({ status: "???" }));
    manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" });
    await manager.submit("s");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expect(manager.observe("s", { status: "MINED", transactionHash: TX_A }).ok).toBe(false);
    expect(manager.operation("s")?.transactionHashes).toEqual([TX_A]);
    expect(reconciler.requests.at(-1)).toMatchObject({ trigger: "WALLET_OPERATION_UNKNOWN", transactionHashes: [TX_A] });
    const refused = manager.resolveByReconciliation("s", authoritative("FAILED", TX_B));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("WALLET_OP_EVIDENCE_CONFLICT");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    // Amended in r7 (WP300-R7-X1): the refused FAILED(B) is weighed, not thrown
    // away, so B joined the set and must be resolved by name too.
    expect(manager.operation("s")?.unresolvedTransactions).toEqual([`hash:${TX_A}`, `hash:${TX_B}`]);
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)).ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    // Control: both witnessed transactions resolved: released.
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)).ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
  });

  it("control: a single consistent identity still resolves in one answer", async () => {
    const { book, manager, answer, submitting } = pendingHarness();
    manager.observe("s", { status: "MINED", transactionHash: TX_A });
    manager.observe("s", { status: "UNKNOWN" });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    await submitting;
    // Amended in r9: since WP300-R9-01 the buffered MINED(A) and the UNKNOWN that sent the operation back
    // are weighed under reconciliation, so the one member is named in the request (it was `[]`, simple
    // mode, before r9). One answer naming it still resolves the operation.
    expect(manager.operation("s")).toMatchObject({ transactionHashes: [TX_A], unresolvedTransactions: [`hash:${TX_A}`] });
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)).ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
  });
});

// ----------------------------------------------------------------- R3-02 --

describe("WP300-R3-02: nothing concludes while the executor is pending, so late executor evidence stays reconcilable", () => {
  it("the verifier's reproduction: CONFIRMED(A) is deferred; late SUBMITTED(B) leaves both to resolve; nothing is spendable meanwhile", async () => {
    const { book, manager, reconciler, answer, submitting } = pendingHarness();
    manager.observe("s", { status: "UNKNOWN" });
    const early = manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A));
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.refusal.code).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    // The 90 pUSD read is refused: the lines are still in flight.
    expect(read(book, PUSD, "90").ok).toBe(false);
    expect(reserveAll(book, "90").ok).toBe(true); // 90 of 100 were always free
    expect(reserveAll(book, "0.01", "probe-2").ok).toBe(false); // the operation's 10 are not

    answer.resolve({ status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    await submitting;
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", transactionHashes: [TX_A, TX_B] });
    expect(reconciler.requests.at(-1)?.transactionHashes).toEqual([TX_A, TX_B]);
    // The follow-up request is answerable.
    const partial = manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A));
    expect(partial.ok && partial.value.state).toBe("RECONCILING");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("100");
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)).ok).toBe(true);
    expect(manager.operation("s")?.state).toBe("CONFIRMED");
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("AWAITING_OBSERVATION");
  });

  for (const [name, late] of [
    ["NOT_SENT", { status: "NOT_SENT" }],
    ["unrecognised", { status: "???" }],
  ] as const) {
    it(`a late ${name} answer: the follow-up request is answerable and the operation concludes`, async () => {
      const { book, manager, reconciler, answer, submitting } = pendingHarness();
      manager.observe("s", { status: "UNKNOWN" });
      expect(manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A)).ok).toBe(false);
      answer.resolve(late);
      await submitting;
      expect(manager.operation("s")?.state).toBe("RECONCILING");
      expect(reconciler.requests).toHaveLength(2);
      expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
      const answered = manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A));
      expect(answered.ok && answered.value.state).toBe("CONFIRMED");
    });
  }

  it("a CONFIRMED observation after a refused 'still in flight' answer is weighed, never applied, while the executor is pending; a contradiction keeps it under reconciliation [amended in r9]", async () => {
    // Amended in r9: this pin used to return the operation to flight while the executor was pending (a
    // "still in flight" answer after the DROPPED) and keep the CONFIRMED observation there. Since
    // WP300-R9-01 the DROPPED that sent the operation back is weighed under reconciliation, so the
    // "still in flight" answer is refused (and weighed): that route is closed. The pin now checks the
    // same promise on the route that remains — nothing concludes, nothing is applied, the holds stay.
    const { book, manager, answer, submitting } = pendingHarness();
    manager.observe("s", { status: "DROPPED" });
    const inFlight = manager.resolveByReconciliation("s", authoritative("SUBMITTED", TX_A));
    expect(!inFlight.ok && inFlight.refusal.code).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    const weighed = manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(!weighed.ok && weighed.refusal.code).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", bufferedObservations: 0, effectsApplied: false });
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    await submitting;
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", effectsApplied: false, bufferedObservations: 0 });
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
  });

  for (const late of [{ status: "NOT_SENT" }, { status: "???" }] as const) {
    it(`a late ${late.status} after a refused 'still in flight' answer keeps the operation under reconciliation (the CONFIRMED observation not applied) [amended in r9]`, async () => {
      // Amended in r9: this pin used to return the operation to flight while the executor was pending (a
      // "still in flight" answer after the DROPPED) and keep the CONFIRMED observation there. Since
      // WP300-R9-01 the DROPPED that sent the operation back is weighed under reconciliation, so the
      // "still in flight" answer is refused (and weighed): that route is closed. The pin now checks the
      // same promise on the route that remains — nothing concludes, nothing is applied, the holds stay.
      const { book, manager, reconciler, answer, submitting } = pendingHarness();
      manager.observe("s", { status: "DROPPED" });
      manager.resolveByReconciliation("s", authoritative("SUBMITTED", TX_A));
      manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
      answer.resolve(late);
      await submitting;
      expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", effectsApplied: false, bufferedObservations: 0 });
      // Request 1 (the DROPPED), 2 (the CONFIRMED observation, weighed outside flight) and 3 (the late
      // contradiction, which also carries the request owed for the answer refused while it was pending).
      expect(reconciler.requests).toHaveLength(3);
      expect(reconciler.requests.at(-1)?.unresolvedTransactions).toEqual([`hash:${TX_A}`]);
      expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
    });
  }

  it("control: when the executor's answer agrees, the operation concludes by reconciliation, its CONFIRMED observation never applied [amended in r9]", async () => {
    // Amended in r9: this pin used to return the operation to flight while the executor was pending (a
    // "still in flight" answer after the DROPPED) and keep the CONFIRMED observation there. Since
    // WP300-R9-01 the DROPPED that sent the operation back is weighed under reconciliation, so the
    // "still in flight" answer is refused (and weighed): that route is closed. The pin now checks the
    // same promise on the route that remains — nothing concludes, nothing is applied, the holds stay.
    // (Observations kept while the operation is PLANNED are still applied when the executor agrees: the
    // WP300-R1-05 pins.)
    const { book, manager, answer, submitting } = pendingHarness();
    manager.observe("s", { status: "DROPPED" });
    manager.resolveByReconciliation("s", authoritative("SUBMITTED", TX_A));
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    await submitting;
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", effectsApplied: false });
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
    expect(manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A)).ok).toBe(true);
    expect(manager.operation("s")).toMatchObject({ state: "CONFIRMED", effectsApplied: false });
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "0", blocked: "AWAITING_OBSERVATION" });
  });

  it("after a terminal state, an observation naming another transaction blocks the lines and reports a discrepancy", async () => {
    const { book, manager, reconciler } = harness(() => Promise.resolve({ status: "NOT_SENT" }));
    manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" });
    await manager.submit("s");
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(reserveAll(book, "100").ok).toBe(true);
    expect(book.release({ reservationId: "probe" }).ok).toBe(true);
    expect(manager.observe("s", { status: "MINED", transactionHash: TX_A }).ok).toBe(false);
    // r4 (WP300-R4-01): a quarantine, which a balance read does not lift (was AWAITING_OBSERVATION).
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("QUARANTINED");
    expect(reserveAll(book, "1", "probe-2").ok).toBe(false);
    expect(reconciler.requests).toEqual([
      expect.objectContaining({ trigger: "POSITION_BALANCE_DISCREPANCY", transactionHashes: [TX_A] }),
    ]);
  });

  it("control: an exact repeat after CONFIRMED blocks nothing", async () => {
    const { book, manager, reconciler } = harness(() =>
      Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }),
    );
    manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" });
    await manager.submit("s");
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null }).ok).toBe(false);
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBeNull();
    expect(reconciler.requests).toEqual([]);
  });
});
