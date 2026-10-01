/**
 * WP-300 remediation round 1: pins for the verifier's findings WP300-R1-01 to
 * WP300-R1-06. Each describe block names its finding; each pin fails against
 * the round-0 candidate (1b7920d) and passes after the fix.
 *
 * All executors, reconcilers and journals are in-memory mocks. Nothing is
 * signed or sent.
 */

import { describe, expect, it } from "vitest";

import {
  ApprovalTracker,
  ReservationService,
  WalletOperationManager,
  type InventoryBook,
  type InventoryJournalEvent,
  type ReconciliationRequest,
  type ReservationJournal,
  type WalletOperationExecutor,
  type WalletOperationSubmission,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, NO, PUSD, YES, seededBook } from "./helpers.js";

const TX_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const TX_B = "0x00000000000000000000000000000000000000000000000000000000000000b2";
const ID_A = "sanitized-transaction-id-a";
const ID_B = "sanitized-transaction-id-b";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  onRequest: ((request: ReconciliationRequest) => void) | undefined;
  failing = false;
  request(request: ReconciliationRequest): void {
    this.requests.push(request);
    this.onRequest?.(request);
    if (this.failing) throw new Error("reconciler queue unavailable");
  }
}

class ScriptedExecutor implements WalletOperationExecutor {
  readonly submitted: WalletOperationSubmission[] = [];
  constructor(readonly respond: (submission: WalletOperationSubmission) => Promise<unknown>) {}
  submit(submission: WalletOperationSubmission): Promise<unknown> {
    this.submitted.push(submission);
    return this.respond(submission);
  }
}

function harness(
  respond: (s: WalletOperationSubmission) => Promise<unknown> = () =>
    Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: ID_A }),
  balances: Readonly<Record<string, string>> = { [PUSD]: "100" },
) {
  const book = seededBook(balances);
  const executor = new ScriptedExecutor(respond);
  const reconciler = new Reconciler();
  const manager = new WalletOperationManager({ book, approvals: new ApprovalTracker(), executor, reconciler });
  return { book, executor, reconciler, manager };
}

const split = (operationId: string, amount: string) => ({
  type: "SPLIT",
  operationId,
  accountRef: ACCOUNT,
  conditionId: CONDITION,
  amount,
});

const read = (book: InventoryBook, assetId: string, balance: string) =>
  book.observeActual({ accountRef: ACCOUNT, assetId, balance });

// ----------------------------------------------------------------- R1-01 --

describe("WP300-R1-01: a settled pending id can never be replayed or reused", () => {
  for (const settlement of ["APPLIED", "VOIDED"] as const) {
    it(`an inflow settled ${settlement} cannot be settled again or re-expected`, () => {
      const book = seededBook({ [PUSD]: "100" });
      expect(book.expectInflow({ pendingId: "receipt-1", accountRef: ACCOUNT, assetId: PUSD, amount: "7" }).ok).toBe(true);
      expect(book.settlePending({ pendingId: "receipt-1", settlement }).ok).toBe(true);
      const expected = settlement === "APPLIED" ? "107" : "100";
      expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: expected, available: expected });

      const again = book.expectInflow({ pendingId: "receipt-1", accountRef: ACCOUNT, assetId: PUSD, amount: "7" });
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.refusal.code).toBe("INVENTORY_DUPLICATE_PENDING_ID");
      for (const replay of ["APPLIED", "VOIDED"] as const) {
        const replayed = book.settlePending({ pendingId: "receipt-1", settlement: replay });
        expect(replayed.ok).toBe(false);
        if (!replayed.ok) expect(replayed.refusal.code).toBe("INVENTORY_PENDING_ALREADY_SETTLED");
      }
      expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: expected, available: expected });
      expect(book.checkInvariants()).toEqual([]);
    });

    it(`a consumed reservation's debit settled ${settlement} cannot be settled again or re-consumed`, () => {
      const book = seededBook({ [YES]: "10" });
      book.reserve({ reservationId: "r1", holderRef: "sell-1", accountRef: ACCOUNT, assetId: YES, amount: "4" });
      book.reserve({ reservationId: "r2", holderRef: "sell-2", accountRef: ACCOUNT, assetId: YES, amount: "4" });
      expect(book.consume({ reservationId: "r1", amount: "4", pendingId: "fill-1" }).ok).toBe(true);
      expect(book.settlePending({ pendingId: "fill-1", settlement }).ok).toBe(true);
      const actual = settlement === "APPLIED" ? "6" : "10";
      expect(book.line(ACCOUNT, YES)?.actual).toBe(actual);

      const replayed = book.settlePending({ pendingId: "fill-1", settlement });
      expect(replayed.ok).toBe(false);
      if (!replayed.ok) expect(replayed.refusal.code).toBe("INVENTORY_PENDING_ALREADY_SETTLED");
      const reused = book.consume({ reservationId: "r2", amount: "1", pendingId: "fill-1" });
      expect(reused.ok).toBe(false);
      if (!reused.ok) expect(reused.refusal.code).toBe("INVENTORY_DUPLICATE_PENDING_ID");
      expect(book.line(ACCOUNT, YES)).toMatchObject({ actual, reserved: "4", pendingOut: "0" });
      expect(book.checkInvariants()).toEqual([]);
    });
  }

  it("the reservation service refuses the replay too, and journals nothing for it", async () => {
    const book = seededBook({ [PUSD]: "100" });
    const events: InventoryJournalEvent[] = [];
    const service = new ReservationService(book, { append: (e) => (events.push(e), Promise.resolve()) });
    expect((await service.expectInflow({ pendingId: "receipt-1", accountRef: ACCOUNT, assetId: PUSD, amount: "7" })).ok).toBe(true);
    expect((await service.settlePending({ pendingId: "receipt-1", settlement: "APPLIED" })).ok).toBe(true);
    expect((await service.settlePending({ pendingId: "receipt-1", settlement: "APPLIED" })).ok).toBe(false);
    expect(events.map((e) => e.kind)).toEqual(["INFLOW_EXPECTED", "PENDING_SETTLED"]);
    expect(service.available(ACCOUNT, PUSD)).toBe("107");
  });
});

// ----------------------------------------------------------------- R1-02 --

describe("WP300-R1-02: a balance read and an operation's confirmation never both apply its effect", () => {
  it("read BEFORE confirmation: the in-flight lines refuse the read; the confirmation applies the effect once", async () => {
    const { book, manager, reconciler } = harness();
    expect(manager.plan(split("s", "10")).ok).toBe(true);
    // Before submission nothing has left: a read is still accepted.
    expect(read(book, PUSD, "100").ok).toBe(true);
    await manager.submit("s");
    for (const [asset, balance] of [
      [PUSD, "90"],
      [YES, "10"],
      [NO, "10"],
    ] as const) {
      const refused = read(book, asset, balance);
      expect(refused.ok, asset).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe("INVENTORY_OPERATION_IN_FLIGHT");
    }
    // The ledger-derived refresh is held back the same way.
    const seeded = book.seedFromLedgerBalances(
      [{ scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: PUSD, assetKind: "COLLATERAL", balance: "90" }],
      { accountRefs: [ACCOUNT] },
    );
    expect(seeded.ok).toBe(false);
    if (!seeded.ok) expect(seeded.refusal.code).toBe("INVENTORY_OPERATION_IN_FLIGHT");

    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: ID_A });
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "90", reserved: "0", available: "90" });
    expect(book.line(ACCOUNT, YES)).toMatchObject({ actual: "10", available: "10" });
    expect(book.line(ACCOUNT, NO)).toMatchObject({ actual: "10", available: "10" });
    expect(reconciler.requests).toEqual([]);
    expect(book.checkInvariants()).toEqual([]);
  });

  it("read AFTER confirmation (reconciliation or ledger refresh) agrees and adds nothing", async () => {
    const { book, manager } = harness();
    manager.plan(split("s", "10"));
    await manager.submit("s");
    manager.observe("s", { status: "MINED", transactionHash: TX_A });
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: ID_A });
    expect(read(book, PUSD, "90").ok && read(book, YES, "10").ok).toBe(true);
    // A complete snapshot of the account (WP300-R2-01): every line it holds.
    const seeded = book.seedFromLedgerBalances(
      [
        { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: PUSD, assetKind: "COLLATERAL", balance: "90" },
        { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: YES, assetKind: "OUTCOME_TOKEN", balance: "10" },
        { scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: NO, assetKind: "OUTCOME_TOKEN", balance: "10" },
      ],
      { accountRefs: [ACCOUNT] },
    );
    expect(seeded.ok).toBe(true);
    if (seeded.ok) expect(seeded.value.map((o) => o.changed)).toEqual([false, false, false]);
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("90");
    expect(book.line(ACCOUNT, YES)?.actual).toBe("10");
    expect(book.reserve({ reservationId: "x", holderRef: "o", accountRef: ACCOUNT, assetId: YES, amount: "10.01" }).ok).toBe(false);
    expect(book.checkInvariants()).toEqual([]);
  });

  it("an UNKNOWN→RECONCILING operation keeps its lines held until reconciliation resolves it; then one read recognises it", async () => {
    const { book, manager } = harness(() => Promise.resolve({ status: "???" }));
    manager.plan(split("s", "10"));
    await manager.submit("s");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expect(read(book, YES, "10").ok).toBe(false);
    manager.resolveByReconciliation("s", { source: "AUTHORITATIVE_READ", state: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(manager.operation("s")).toMatchObject({ state: "CONFIRMED", effectsApplied: false });
    expect(read(book, PUSD, "90").ok && read(book, YES, "10").ok && read(book, NO, "10").ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "90", reserved: "0", available: "90", blocked: null });
    expect(book.line(ACCOUNT, YES)).toMatchObject({ actual: "10", blocked: null });
  });

  it("FAILED and NOT_SENT end the hold: reads are accepted again", async () => {
    const failed = harness();
    failed.manager.plan(split("f", "10"));
    await failed.manager.submit("f");
    failed.manager.observe("f", { status: "FAILED" });
    expect(read(failed.book, PUSD, "100").ok).toBe(true);

    const notSent = harness(() => Promise.resolve({ status: "NOT_SENT" }));
    notSent.manager.plan(split("n", "10"));
    await notSent.manager.submit("n");
    expect(read(notSent.book, PUSD, "100").ok).toBe(true);
  });
});

// ----------------------------------------------------------------- R1-03 --

describe("WP300-R1-03: evidence naming a different transaction is conflicting, never accepted", () => {
  it("SUBMITTED(A) → MINED(A) → CONFIRMED(B): UNKNOWN → reconciliation; holds kept, no effect, identity kept", async () => {
    const { book, manager, reconciler } = harness();
    manager.plan(split("s", "10"));
    await manager.submit("s");
    manager.observe("s", { status: "MINED", transactionHash: TX_A });
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_B, transactionId: null });
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", effectsApplied: false, transactionHash: TX_A });
    expect(reconciler.requests).toEqual([expect.objectContaining({ trigger: "WALLET_OPERATION_UNKNOWN", walletOperationId: "s" })]);
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
    expect(book.line(ACCOUNT, YES)?.actual ?? "0").toBe("0");
  });

  const conflicts: readonly { readonly name: string; readonly observation: unknown }[] = [
    { name: "MINED under another hash", observation: { status: "MINED", transactionHash: TX_B } },
    { name: "CONFIRMED under another relayer id", observation: { status: "CONFIRMED", transactionHash: TX_A, transactionId: ID_B } },
    { name: "SUBMITTED under another hash", observation: { status: "SUBMITTED", transactionHash: TX_B, transactionId: ID_A } },
    { name: "FAILED naming another hash", observation: { status: "FAILED", transactionHash: TX_B } },
  ];
  for (const conflict of conflicts) {
    it(`${conflict.name} → RECONCILING with the reservation held`, async () => {
      const { book, manager, reconciler } = harness();
      manager.plan(split("s", "10"));
      await manager.submit("s");
      manager.observe("s", conflict.observation);
      expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", transactionHash: TX_A, transactionId: ID_A });
      expect(reconciler.requests).toHaveLength(1);
      expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
    });
  }

  it("reconciliation evidence naming another transaction is refused and the operation stays RECONCILING", async () => {
    // Amended in r7 (WP300-R7-X1, the joint report's required amendment): this
    // pin used to end with the matching FAILED(TX_A) releasing the collateral
    // right after the refusals, i.e. it pinned refused evidence being thrown
    // away. Refused evidence is now weighed like an observation: what it names
    // joins the identity set and must be resolved by name before anything is
    // released.
    const { book, manager, reconciler } = harness();
    manager.plan(split("s", "10"));
    await manager.submit("s");
    manager.observe("s", { status: "DROPPED" });
    // Amended in r9: the first answer echoes request 1. Since WP300-R9-01 the DROPPED that sent the
    // operation back is weighed, so an answer echoing no request is taken as read before it (superseded);
    // the identity conflict is checked with a current answer.
    const first = reconciler.requests.at(-1)?.requestId;
    for (const [evidence, code] of [
      [{ source: "AUTHORITATIVE_READ", state: "CONFIRMED", transactionHash: TX_B, transactionId: null, requestId: first }, "WALLET_OP_EVIDENCE_CONFLICT"],
      // TX_B is now a member (the refusal above was weighed), named after the
      // only request this unbound answer could have been read for: superseded.
      [{ source: "AUTHORITATIVE_READ", state: "FAILED", transactionHash: TX_B }, "WALLET_OP_EVIDENCE_SUPERSEDED"],
      // Every member must now be answered terminally by name: an in-flight answer is refused for its shape.
      [{ source: "AUTHORITATIVE_READ", state: "MINED", transactionHash: TX_A, transactionId: ID_B }, "WALLET_OP_EVIDENCE_REQUIRED"],
    ] as const) {
      const refused = manager.resolveByReconciliation("s", evidence);
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe(code);
      expect(manager.operation("s")?.state).toBe("RECONCILING");
      expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    }
    expect(manager.operation("s")).toMatchObject({
      transactionHashes: [TX_A, TX_B],
      transactionIds: [ID_A, ID_B],
      unresolvedTransactions: [`hash:${TX_A}`, `hash:${TX_B}`, `id:${ID_A}`, `id:${ID_B}`],
    });
    // The matching FAILED(TX_A) is accepted, but no longer releases anything. (Amended in r9: it echoes
    // the latest request — the weighed DROPPED supersedes an answer echoing none.)
    const matching = manager.resolveByReconciliation("s", {
      source: "AUTHORITATIVE_READ",
      state: "FAILED",
      transactionHash: TX_A,
      requestId: reconciler.requests.at(-1)?.requestId,
    });
    expect(matching.ok && matching.value.state).toBe("RECONCILING");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    // Recovery: every other member answered by name, for the latest request.
    const requestId = reconciler.requests.at(-1)?.requestId;
    for (const [transactionHash, transactionId] of [
      [TX_B, null],
      [null, ID_A],
      [null, ID_B],
    ] as const) {
      expect(
        manager.resolveByReconciliation("s", { source: "AUTHORITATIVE_READ", state: "FAILED", transactionHash, transactionId, requestId }).ok,
      ).toBe(true);
    }
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
  });

  it("a malformed identity field is unrecognised, not ignored", async () => {
    const { manager } = harness();
    manager.plan(split("s", "10"));
    await manager.submit("s");
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: 42 });
    expect(manager.operation("s")?.state).toBe("RECONCILING");
  });
});

// ----------------------------------------------------------------- R1-04 --

class ManualJournal implements ReservationJournal {
  readonly pending: { readonly event: InventoryJournalEvent; readonly done: Deferred<void> }[] = [];
  append(event: InventoryJournalEvent): Promise<void> {
    const done = deferred<void>();
    this.pending.push({ event, done });
    return done.promise;
  }
  at(index: number): Deferred<void> {
    const entry = this.pending[index];
    if (entry === undefined) throw new Error(`no append #${String(index)}`);
    return entry.done;
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("WP300-R1-04: no success is acknowledged across a failed or unresolved earlier journal write", () => {
  it("release's append fails, then the dependent reservation's append succeeds: the reservation is NOT acknowledged", async () => {
    const book = seededBook({ [PUSD]: "100" });
    const journal = new ManualJournal();
    const service = new ReservationService(book, journal);
    const first = service.reserve({ reservationId: "r1", holderRef: "o1", accountRef: ACCOUNT, assetId: PUSD, amount: "100" });
    journal.at(0).resolve();
    expect((await first).ok).toBe(true);

    const release = service.release({ reservationId: "r1" });
    const second = service.reserve({ reservationId: "r2", holderRef: "o2", accountRef: ACCOUNT, assetId: PUSD, amount: "100" });
    journal.at(1).reject(new Error("disk full"));
    journal.at(2).resolve();
    const [released, reserved] = await Promise.all([release, second]);
    expect(released.ok).toBe(false);
    expect(reserved.ok).toBe(false);
    if (!reserved.ok) expect(reserved.refusal.code).toBe("INVENTORY_JOURNAL_FAILED");
    expect(service.faulted).toBe(true);
  });

  it("a later append that succeeds first waits for the earlier one before acknowledging", async () => {
    const book = seededBook({ [PUSD]: "100" });
    const journal = new ManualJournal();
    const service = new ReservationService(book, journal);
    const a = service.reserve({ reservationId: "a", holderRef: "oa", accountRef: ACCOUNT, assetId: PUSD, amount: "10" });
    const b = service.reserve({ reservationId: "b", holderRef: "ob", accountRef: ACCOUNT, assetId: PUSD, amount: "10" });
    let bSettled = false;
    void b.then(() => (bSettled = true));
    journal.at(1).resolve();
    await tick();
    expect(bSettled, "b must not be acknowledged while a's write is unresolved").toBe(false);
    journal.at(0).reject(new Error("timeout"));
    expect((await a).ok).toBe(false);
    expect((await b).ok).toBe(false);
  });

  it("a mutation made reentrantly inside a synchronous append that then throws is not acknowledged", async () => {
    const book = seededBook({ [PUSD]: "100" });
    const ref: { service?: ReservationService } = {};
    let nested: Promise<unknown> | undefined;
    const journal: ReservationJournal = {
      append(event) {
        if (event.kind === "RESERVED" && event.reservation.reservationId === "outer") {
          nested = ref.service?.reserve({ reservationId: "inner", holderRef: "oi", accountRef: ACCOUNT, assetId: PUSD, amount: "5" });
          throw new Error("journal driver crashed");
        }
        return Promise.resolve();
      },
    };
    const service = new ReservationService(book, journal);
    ref.service = service;
    const outer = await service.reserve({ reservationId: "outer", holderRef: "oo", accountRef: ACCOUNT, assetId: PUSD, amount: "5" });
    expect(outer.ok).toBe(false);
    expect(nested).toBeDefined();
    const inner = (await nested) as { ok: boolean; refusal?: { code: string } };
    expect(inner.ok).toBe(false);
    expect(inner.refusal?.code).toBe("INVENTORY_JOURNAL_FAILED");
    expect(service.faulted).toBe(true);
  });

  it("a reentrant mutation depends on the outer append even when the outer append fails LATER (asynchronously)", async () => {
    const book = seededBook({ [PUSD]: "100" });
    const ref: { service?: ReservationService } = {};
    const outerWrite = deferred<void>();
    let nested: Promise<{ ok: boolean }> | undefined;
    const journal: ReservationJournal = {
      append(event) {
        if (event.kind === "RESERVED" && event.reservation.reservationId === "outer") {
          nested = ref.service?.reserve({ reservationId: "inner", holderRef: "oi", accountRef: ACCOUNT, assetId: PUSD, amount: "5" });
          return outerWrite.promise;
        }
        return Promise.resolve();
      },
    };
    const service = new ReservationService(book, journal);
    ref.service = service;
    const outer = service.reserve({ reservationId: "outer", holderRef: "oo", accountRef: ACCOUNT, assetId: PUSD, amount: "5" });
    let innerSettled = false;
    void nested?.then(() => (innerSettled = true));
    await tick();
    expect(innerSettled, "the inner mutation must wait for the outer append").toBe(false);
    outerWrite.reject(new Error("journal unavailable"));
    expect((await outer).ok).toBe(false);
    expect((await nested)?.ok).toBe(false);
  });

  it("non-vacuity: when every append succeeds, out-of-order completion still acknowledges all of them", async () => {
    const book = seededBook({ [PUSD]: "100" });
    const journal = new ManualJournal();
    const service = new ReservationService(book, journal);
    const a = service.reserve({ reservationId: "a", holderRef: "oa", accountRef: ACCOUNT, assetId: PUSD, amount: "10" });
    const b = service.release({ reservationId: "a" });
    journal.at(1).resolve();
    journal.at(0).resolve();
    expect((await a).ok && (await b).ok).toBe(true);
    expect(service.faulted).toBe(false);
  });
});

// ----------------------------------------------------------------- R1-05 --

describe("WP300-R1-05: observations that arrive during submission are kept and applied, never dropped", () => {
  it("an UNKNOWN observation during submission triggers reconciliation (at once since r2; still RECONCILING after SUBMITTED)", async () => {
    const answer = deferred<unknown>();
    const { book, manager, reconciler } = harness(() => answer.promise);
    manager.plan(split("s", "10"));
    const submitting = manager.submit("s");
    const observed = manager.observe("s", { status: "UNKNOWN" });
    // WP300-R2-02: uncertainty is acted on immediately, not buffered behind the executor.
    expect(observed.ok && observed.value).toMatchObject({ state: "RECONCILING", submitting: true, bufferedObservations: 0 });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    await submitting;
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", bufferedObservations: 0, transactionHash: TX_A });
    // Amended in r9: since WP300-R9-01 the UNKNOWN that sent the operation back is weighed under
    // reconciliation, so the transaction the executor names afterwards must be answered by name, and a
    // second request names it (there was one request before r9).
    expect(reconciler.requests).toEqual([
      expect.objectContaining({ trigger: "WALLET_OPERATION_UNKNOWN", walletOperationId: "s" }),
      expect.objectContaining({ trigger: "WALLET_OPERATION_UNKNOWN", walletOperationId: "s", unresolvedTransactions: [`hash:${TX_A}`] }),
    ]);
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
  });

  it("MINED and CONFIRMED observed during submission are applied in order after SUBMITTED", async () => {
    const answer = deferred<unknown>();
    const { book, manager } = harness(() => answer.promise);
    manager.plan(split("s", "10"));
    const submitting = manager.submit("s");
    manager.observe("s", { status: "MINED", transactionHash: TX_A });
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    await submitting;
    expect(manager.events("s").map((e) => e.newState)).toEqual(["PLANNED", "SUBMITTED", "MINED", "CONFIRMED"]);
    expect(book.line(ACCOUNT, YES)?.actual).toBe("10");
  });

  it("an observation from inside the executor call (synchronous) is buffered too", async () => {
    const ref: { manager?: WalletOperationManager } = {};
    const h = harness((submission) => {
      ref.manager?.observe(submission.operationId, { status: "DROPPED" });
      return Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    });
    ref.manager = h.manager;
    h.manager.plan(split("s", "10"));
    await h.manager.submit("s");
    expect(h.manager.operation("s")?.state).toBe("RECONCILING");
    // Amended in r9: since WP300-R9-01 the DROPPED is weighed when it sends the operation back, so the
    // executor's SUBMITTED(A) names a member that must be answered by name: a second request (one before r9).
    expect(h.reconciler.requests).toHaveLength(2);
    expect(h.reconciler.requests[1]?.unresolvedTransactions).toEqual([`hash:${TX_A}`]);
  });

  it("NOT_SENT contradicted by an observation made meanwhile is UNKNOWN, not FAILED; the reservation stays", async () => {
    const answer = deferred<unknown>();
    const { book, manager, reconciler } = harness(() => answer.promise);
    manager.plan(split("s", "10"));
    const submitting = manager.submit("s");
    manager.observe("s", { status: "MINED", transactionHash: TX_A });
    answer.resolve({ status: "NOT_SENT" });
    await submitting;
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    expect(reconciler.requests).toHaveLength(1);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
  });

  it("an observation on a PLANNED operation that is not submitting is still refused", () => {
    const { manager } = harness();
    manager.plan(split("s", "10"));
    const refused = manager.observe("s", { status: "UNKNOWN" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("WALLET_OP_ILLEGAL_TRANSITION");
  });
});

// ----------------------------------------------------------------- R1-06 --

describe("WP300-R1-06: a reconciliation answer given synchronously inside the request is accepted", () => {
  const unknownExecutor = () => Promise.resolve({ status: "???" });

  it("authoritative FAILED from inside request(): the operation is FAILED and its reservation released", async () => {
    const { book, manager, reconciler } = harness(unknownExecutor);
    let answered: boolean | undefined;
    reconciler.onRequest = (request) => {
      answered = manager.resolveByReconciliation(request.walletOperationId, { source: "AUTHORITATIVE_READ", state: "FAILED" }).ok;
    };
    manager.plan(split("s", "10"));
    await manager.submit("s");
    expect(answered).toBe(true);
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(manager.events("s").map((e) => e.newState)).toEqual(["PLANNED", "UNKNOWN", "RECONCILING", "FAILED"]);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
    expect(manager.outstandingReconciliationRequests()).toEqual([]);
  });

  it("authoritative CONFIRMED from inside request(): CONFIRMED, lines await one read", async () => {
    const { book, manager, reconciler } = harness(unknownExecutor);
    reconciler.onRequest = (request) => {
      manager.resolveByReconciliation(request.walletOperationId, {
        source: "AUTHORITATIVE_READ",
        state: "CONFIRMED",
        transactionHash: TX_A,
        transactionId: null,
      });
    };
    manager.plan(split("s", "10"));
    await manager.submit("s");
    expect(manager.operation("s")?.state).toBe("CONFIRMED");
    expect(book.line(ACCOUNT, YES)?.blocked).toBe("AWAITING_OBSERVATION");
  });

  it("an inconclusive synchronous answer is refused and the delivered request leaves the operation RECONCILING", async () => {
    const { manager, reconciler } = harness(unknownExecutor);
    let refusal: string | undefined;
    reconciler.onRequest = (request) => {
      const r = manager.resolveByReconciliation(request.walletOperationId, { source: "AUTHORITATIVE_READ", state: "NOT_FOUND" });
      if (!r.ok) refusal = r.refusal.code;
    };
    manager.plan(split("s", "10"));
    await manager.submit("s");
    expect(refusal).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
  });

  it("a requester that answers and then throws: the answer stands and no request is queued", async () => {
    const { manager, reconciler } = harness(unknownExecutor);
    reconciler.failing = true;
    reconciler.onRequest = (request) => {
      manager.resolveByReconciliation(request.walletOperationId, { source: "AUTHORITATIVE_READ", state: "FAILED" });
    };
    manager.plan(split("s", "10"));
    await manager.submit("s");
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(manager.outstandingReconciliationRequests()).toEqual([]);
  });

  it("request failure recovery is preserved: UNKNOWN + queued; a synchronous answer on retry is accepted", async () => {
    const { book, manager, reconciler } = harness(unknownExecutor);
    reconciler.failing = true;
    manager.plan(split("s", "10"));
    await manager.submit("s");
    expect(manager.operation("s")?.state).toBe("UNKNOWN");
    expect(manager.outstandingReconciliationRequests()).toHaveLength(1);
    // Outside a request call, UNKNOWN still refuses evidence as a resolution.
    expect(manager.resolveByReconciliation("s", { source: "AUTHORITATIVE_READ", state: "FAILED" }).ok).toBe(false);
    // Amended in r7 (WP300-R7-X1/X3): the refused FAILED is weighed like an
    // observation of the UNKNOWN operation. It is a doubt, which supersedes
    // CONFIRMED reads made for the queued request, so a second request (one a
    // current answer can name) is queued too.
    expect(manager.outstandingReconciliationRequests()).toHaveLength(2);
    reconciler.failing = false;
    reconciler.onRequest = (request) => {
      manager.resolveByReconciliation(request.walletOperationId, {
        source: "AUTHORITATIVE_READ",
        state: "FAILED",
        requestId: request.requestId,
      });
    };
    // Neither queued request is delivered late: the superseded advancing one is
    // re-issued fresh (and answered synchronously); the plain one it supersedes
    // in turn is dropped.
    expect(manager.retryReconciliationRequests()).toBe(1);
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(manager.outstandingReconciliationRequests()).toEqual([]);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
  });
});
