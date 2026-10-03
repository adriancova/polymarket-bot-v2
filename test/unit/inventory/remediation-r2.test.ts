/**
 * WP-300 remediation round 2: pins for the verifier's findings WP300-R2-01 to
 * WP300-R2-03. Each describe block names its finding; each pin fails against
 * the round-1 candidate (b8af478) and passes after the fix (controls are
 * marked as such).
 *
 * All executors, reconcilers and journals are in-memory mocks. The ledger
 * used by the R2-01 pins is the real `packages/ledger` (PAPER, in memory).
 * Nothing is signed or sent.
 */

import { describe, expect, it } from "vitest";

import {
  ApprovalTracker,
  AssetRegistry,
  InventoryBook,
  MAX_IDENTIFIER_LENGTH,
  WalletOperationManager,
  reserveForOrder,
  type ReconciliationRequest,
  type WalletOperationExecutor,
  type WalletOperationSubmission,
} from "../../../packages/inventory/src/index.js";
import { Ledger, balancesOfScope, projectLedger } from "../../../packages/ledger/src/index.js";
import {
  ACCOUNT as LEDGER_ACCOUNT,
  ATTRIBUTION_CLEARING,
  NO_TOKEN,
  OTHER_ACCOUNT,
  PUSD as LEDGER_PUSD,
  VENUE_CLEARING,
  YES_TOKEN,
  token,
  transaction,
  tx,
  unattributedDeposit,
} from "../../../packages/ledger/src/testing/scenarios.js";
import { ACCOUNT, CONDITION, NO, PUSD, YES, requestTokens, seededBook } from "./helpers.js";

const TX_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const TX_B = "0x00000000000000000000000000000000000000000000000000000000000000b2";

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

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  onRequest: ((request: ReconciliationRequest) => void) | undefined;
  request(request: ReconciliationRequest): void {
    this.requests.push(request);
    this.onRequest?.(request);
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
    Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }),
  balances: Readonly<Record<string, string>> = { [PUSD]: "100" },
) {
  const book = seededBook(balances);
  const executor = new ScriptedExecutor(respond);
  const reconciler = new Reconciler();
  const manager = new WalletOperationManager({ requestToken: requestTokens(), book, approvals: new ApprovalTracker(), executor, reconciler });
  return { book, executor, reconciler, manager };
}

const split = (operationId: string, amount: string) => ({
  type: "SPLIT",
  operationId,
  accountRef: ACCOUNT,
  conditionId: CONDITION,
  amount,
});

/** The package's collision-free key format (guards.ts `compositeKey`), restated for the test. */
const key = (...parts: readonly string[]): string => parts.map((p) => `${String(p.length)}:${p};`).join("");

// ----------------------------------------------------------------- R2-01 --

describe("WP300-R2-01: a ledger refresh clears balances the complete snapshot no longer holds", () => {
  const LEDGER_CONDITION = "0x00000000000000000000000000000000000000000000000000000000000000c1";

  function ledgerRegistry(): AssetRegistry {
    const created = AssetRegistry.create({ pusdAssetId: LEDGER_PUSD });
    if (!created.ok) throw new Error(created.refusal.message);
    const pair = created.value.registerOutcomePair({
      conditionId: LEDGER_CONDITION,
      yesAssetId: YES_TOKEN,
      noAssetId: NO_TOKEN,
    });
    if (!pair.ok) throw new Error(pair.refusal.message);
    return created.value;
  }

  /** A balanced, attribution-neutral movement of `amount` YES tokens into (+) or out of (−) the account. */
  function tokenMovement(id: string, amount: string, sign: "+" | "-") {
    const signed = (a: string, flip: boolean) => ((sign === "+") !== flip ? a : `-${a}`);
    return transaction({
      ledgerTransactionId: id,
      eventType: sign === "+" ? "DEPOSIT_OBSERVED" : "WITHDRAWAL_OBSERVED",
      entries: [
        token("ACTUAL_ACCOUNT", LEDGER_ACCOUNT, signed(amount, false)),
        token("EXTERNAL_CLEARING", VENUE_CLEARING, signed(amount, true)),
        token("UNATTRIBUTED", LEDGER_ACCOUNT, signed(amount, false)),
        token("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, signed(amount, true)),
      ],
    });
  }

  const actualRows = (ledger: Ledger) => balancesOfScope(projectLedger(ledger), "ACTUAL_ACCOUNT");
  const coverage = { accountRefs: [LEDGER_ACCOUNT] };

  /** The ledger is persistent: append returns the extended ledger. */
  function append(ledger: Ledger, input: unknown): Ledger {
    const appended = ledger.append(input);
    if (!appended.ok) throw new Error(`ledger refused the fixture: ${JSON.stringify(appended)}`);
    return appended.value.ledger;
  }

  const sell = (book: InventoryBook, size: string) =>
    reserveForOrder(book, {
      reservationId: "sell-1",
      orderRef: "order-sell-1",
      accountRef: LEDGER_ACCOUNT,
      side: "SELL",
      tokenAssetId: YES_TOKEN,
      price: "0.5",
      size,
    });

  it("the account's LAST balance disappears from the projection: the refresh reads it as zero and the SELL is refused", () => {
    let ledger = Ledger.empty("PAPER");
    const book = new InventoryBook(ledgerRegistry());
    ledger = append(ledger, tokenMovement(tx(1), "10", "+"));
    expect(book.seedFromLedgerBalances(actualRows(ledger), coverage).ok).toBe(true);
    expect(book.line(LEDGER_ACCOUNT, YES_TOKEN)?.actual).toBe("10");

    ledger = append(ledger, tokenMovement(tx(2), "10", "-"));
    expect(actualRows(ledger)).toEqual([]); // the projection drops the zero row
    const refreshed = book.seedFromLedgerBalances(actualRows(ledger), coverage);
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      expect(refreshed.value).toEqual([
        expect.objectContaining({ accountRef: LEDGER_ACCOUNT, assetId: YES_TOKEN, previous: "10", observed: "0", changed: true }),
      ]);
    }
    expect(book.line(LEDGER_ACCOUNT, YES_TOKEN)).toMatchObject({ actual: "0", available: "0" });
    const refused = sell(book, "10");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("INVENTORY_INSUFFICIENT_AVAILABLE");
    expect(book.checkInvariants()).toEqual([]);
  });

  it("one asset reaches zero while another remains: only the vanished one is cleared", () => {
    let ledger = Ledger.empty("PAPER");
    const book = new InventoryBook(ledgerRegistry());
    ledger = append(ledger, unattributedDeposit(tx(1), "250"));
    ledger = append(ledger, tokenMovement(tx(2), "10", "+"));
    expect(book.seedFromLedgerBalances(actualRows(ledger), coverage).ok).toBe(true);
    expect(book.line(LEDGER_ACCOUNT, YES_TOKEN)?.actual).toBe("10");
    ledger = append(ledger, tokenMovement(tx(3), "10", "-"));
    expect(book.seedFromLedgerBalances(actualRows(ledger), coverage).ok).toBe(true);
    expect(book.line(LEDGER_ACCOUNT, LEDGER_PUSD)?.actual).toBe("250");
    expect(book.line(LEDGER_ACCOUNT, YES_TOKEN)?.actual).toBe("0");
    expect(sell(book, "10").ok).toBe(false);
    // Control: a partial removal is carried as the ledger's remaining balance.
    let again = Ledger.empty("PAPER");
    const book2 = new InventoryBook(ledgerRegistry());
    again = append(again, tokenMovement(tx(1), "10", "+"));
    again = append(again, tokenMovement(tx(2), "4", "-"));
    expect(book2.seedFromLedgerBalances(actualRows(again), coverage).ok).toBe(true);
    expect(book2.line(LEDGER_ACCOUNT, YES_TOKEN)?.actual).toBe("6");
    expect(sell(book2, "6").ok).toBe(true);
  });

  it("a refresh must declare its coverage; lines outside it, and duplicate lines, are refused", () => {
    const book = new InventoryBook(ledgerRegistry());
    const row = { scope: "ACTUAL_ACCOUNT", accountRef: LEDGER_ACCOUNT, assetId: YES_TOKEN, assetKind: "OUTCOME_TOKEN", balance: "3" };
    const refusals = [
      // @ts-expect-error — coverage is required
      book.seedFromLedgerBalances([row]),
      book.seedFromLedgerBalances([row], { accountRefs: [] }),
      book.seedFromLedgerBalances([row], { accountRefs: [LEDGER_ACCOUNT, LEDGER_ACCOUNT] }),
      book.seedFromLedgerBalances([row], { accountRefs: [OTHER_ACCOUNT] }),
      book.seedFromLedgerBalances([row, row], coverage),
    ];
    for (const refused of refusals) {
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.refusal.code).toBe("INVENTORY_INVALID_INPUT");
    }
    expect(book.line(LEDGER_ACCOUNT, YES_TOKEN)).toBeUndefined();
  });

  it("an account outside the declared coverage is untouched", () => {
    const book = new InventoryBook(ledgerRegistry());
    expect(book.observeActual({ accountRef: OTHER_ACCOUNT, assetId: YES_TOKEN, balance: "7" }).ok).toBe(true);
    expect(book.observeActual({ accountRef: LEDGER_ACCOUNT, assetId: YES_TOKEN, balance: "5" }).ok).toBe(true);
    expect(book.seedFromLedgerBalances([], coverage).ok).toBe(true);
    expect(book.line(LEDGER_ACCOUNT, YES_TOKEN)?.actual).toBe("0");
    expect(book.line(OTHER_ACCOUNT, YES_TOKEN)?.actual).toBe("7");
  });

  it("an absent line is a read too: unresolved pending amounts on it refuse the whole refresh, applying nothing", () => {
    const book = new InventoryBook(ledgerRegistry());
    book.observeActual({ accountRef: LEDGER_ACCOUNT, assetId: YES_TOKEN, balance: "10" });
    book.observeActual({ accountRef: LEDGER_ACCOUNT, assetId: LEDGER_PUSD, balance: "40" });
    expect(book.expectInflow({ pendingId: "fill-1", accountRef: LEDGER_ACCOUNT, assetId: YES_TOKEN, amount: "2" }).ok).toBe(true);
    const refused = book.seedFromLedgerBalances(
      [{ scope: "ACTUAL_ACCOUNT", accountRef: LEDGER_ACCOUNT, assetId: LEDGER_PUSD, assetKind: "COLLATERAL", balance: "30" }],
      coverage,
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("INVENTORY_PENDING_UNRESOLVED");
    expect(book.line(LEDGER_ACCOUNT, LEDGER_PUSD)?.actual).toBe("40");
    expect(book.line(LEDGER_ACCOUNT, YES_TOKEN)?.actual).toBe("10");
  });
});

// ----------------------------------------------------------------- R2-02 --

describe("WP300-R2-02: uncertainty observed during submission is reconciled at once and never discarded", () => {
  it("UNKNOWN while the executor is pending: reconciliation is requested immediately, without the executor answering", async () => {
    const answer = deferred<unknown>();
    const { book, manager, reconciler } = harness(() => answer.promise);
    manager.plan(split("s", "10"));
    const submitting = manager.submit("s");
    const observed = manager.observe("s", { status: "UNKNOWN" });
    expect(observed.ok).toBe(true);
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", submitting: true });
    expect(reconciler.requests).toEqual([expect.objectContaining({ trigger: "WALLET_OPERATION_UNKNOWN", walletOperationId: "s" })]);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    // Since r3 (WP300-R3-02) no terminal conclusion is drawn while the executor
    // is still silent: CONFIRMED is deferred like FAILED, and asked for again.
    const evidence = { source: "AUTHORITATIVE_READ", state: "CONFIRMED", transactionHash: TX_A, transactionId: null };
    // Amended in r9: the early answer echoes request 1. Since WP300-R9-01 the UNKNOWN that sent the
    // operation back is weighed, so an answer echoing no request is taken as read before it (superseded);
    // the refusal while the executor is pending is checked with a current answer.
    const early = manager.resolveByReconciliation("s", { ...evidence, requestId: reconciler.requests[0]?.requestId });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.refusal.code).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    await submitting;
    expect(reconciler.requests).toHaveLength(2);
    // r7 (WP300-R7-X3): the answer is given again for the follow-up request. (The
    // deferred CONFIRMED was weighed, naming A outside flight, so a read made
    // for the first request no longer counts for A.)
    expect(manager.resolveByReconciliation("s", { ...evidence, requestId: reconciler.requests[1]?.requestId }).ok).toBe(true);
    expect(manager.operation("s")?.state).toBe("CONFIRMED");
  });

  for (const first of [
    { status: "CONFIRMED", transactionHash: TX_A, transactionId: null },
    { status: "FAILED", transactionHash: TX_A, transactionId: null },
    { status: "MINED", transactionHash: TX_A },
  ] as const) {
    it(`buffered ${first.status}(A) then UNKNOWN, executor SUBMITTED(A): reconciliation, nothing applied or released`, async () => {
      const answer = deferred<unknown>();
      const { book, manager, reconciler } = harness(() => answer.promise);
      manager.plan(split("s", "10"));
      const submitting = manager.submit("s");
      manager.observe("s", first);
      manager.observe("s", { status: "UNKNOWN" });
      expect(reconciler.requests).toHaveLength(1);
      answer.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      await submitting;
      expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", effectsApplied: false, bufferedObservations: 0 });
      expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
      expect(book.available(ACCOUNT, YES)).toBe("0");
      expect(book.line(ACCOUNT, YES)?.actual ?? "0").toBe("0");
      expect(reconciler.requests.length).toBeGreaterThanOrEqual(1);
    });
  }

  for (const [name, later] of [
    ["MINED after CONFIRMED", { status: "MINED", transactionHash: TX_A }],
    ["FAILED after CONFIRMED", { status: "FAILED", transactionHash: TX_A, transactionId: null }],
    ["CONFIRMED under another hash", { status: "CONFIRMED", transactionHash: TX_B, transactionId: null }],
  ] as const) {
    it(`buffered CONFIRMED(A) then ${name}: the whole buffer goes to reconciliation before anything is applied`, async () => {
      const answer = deferred<unknown>();
      const { book, manager, reconciler } = harness(() => answer.promise);
      manager.plan(split("s", "10"));
      const submitting = manager.submit("s");
      manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
      manager.observe("s", later);
      answer.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
      await submitting;
      expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", effectsApplied: false });
      expect(manager.events("s").map((e) => e.newState)).toEqual(["PLANNED", "SUBMITTED", "UNKNOWN", "RECONCILING"]);
      expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "10" });
      expect(reconciler.requests).toHaveLength(1);
    });
  }

  it("control: an exact repeat of the terminal observation is consistent and applied once", async () => {
    const answer = deferred<unknown>();
    const { book, manager, reconciler } = harness(() => answer.promise);
    manager.plan(split("s", "10"));
    const submitting = manager.submit("s");
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null });
    await submitting;
    expect(manager.operation("s")).toMatchObject({ state: "CONFIRMED", effectsApplied: true });
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("90");
    expect(book.line(ACCOUNT, YES)?.actual).toBe("10");
    expect(reconciler.requests).toEqual([]);
  });

  it("FAILED is not concluded while the executor call is pending; the reconciler is asked again once it answers", async () => {
    const answer = deferred<unknown>();
    const { book, manager, reconciler } = harness(() => answer.promise);
    manager.plan(split("s", "10"));
    const submitting = manager.submit("s");
    manager.observe("s", { status: "DROPPED" });
    // Amended in r9: the early answer echoes request 1. Since WP300-R9-01 the DROPPED that sent the
    // operation back is weighed, so an answer echoing no request is taken as read before it (superseded);
    // the refusal while the executor is pending is checked with a current answer.
    const early = manager.resolveByReconciliation("s", {
      source: "AUTHORITATIVE_READ",
      state: "FAILED",
      requestId: reconciler.requests[0]?.requestId,
    });
    expect(early.ok).toBe(false);
    if (!early.ok) expect(early.refusal.code).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    answer.resolve({ status: "NOT_SENT" });
    await submitting;
    expect(reconciler.requests).toHaveLength(2);
    expect(reconciler.requests[1]?.reason).toMatch(/NOT_SENT/);
    // r7 (WP300-R7-X3): the answer names the follow-up request. (The late NOT_SENT
    // is a contradiction, weighed like an unrecognised observation: a read made
    // for the first request no longer counts.)
    expect(
      manager.resolveByReconciliation("s", { source: "AUTHORITATIVE_READ", state: "FAILED", requestId: reconciler.requests[1]?.requestId }).ok,
    ).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");
  });

  it("a late executor answer that contradicts reconciliation's SUBMITTED keeps the operation under reconciliation [amended in r9]", async () => {
    // Amended in r9: this pin used to return the operation to flight while the executor was pending (a
    // "still in flight" answer after the DROPPED) and keep the FAILED observation there. Since
    // WP300-R9-01 the DROPPED that sent the operation back is weighed under reconciliation, so the
    // "still in flight" answer is refused (and weighed): that route is closed. The FAILED observation is
    // weighed outside flight, and the late contradiction keeps everything under reconciliation.
    const answer = deferred<unknown>();
    const { book, manager, reconciler } = harness(() => answer.promise);
    manager.plan(split("s", "10"));
    const submitting = manager.submit("s");
    manager.observe("s", { status: "DROPPED" });
    const inFlight = manager.resolveByReconciliation("s", {
      source: "AUTHORITATIVE_READ",
      state: "SUBMITTED",
      transactionHash: TX_A,
      transactionId: null,
    });
    expect(!inFlight.ok && inFlight.refusal.code).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(manager.operation("s")?.state).toBe("RECONCILING");
    // A FAILED observation is not concluded while the executor is still pending: it is weighed.
    const failed = manager.observe("s", { status: "FAILED", transactionHash: TX_A });
    expect(!failed.ok && failed.refusal.code).toBe("WALLET_OP_ILLEGAL_TRANSITION");
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", bufferedObservations: 0 });
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
    answer.resolve({ status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    await submitting;
    expect(manager.operation("s")).toMatchObject({ state: "RECONCILING", transactionHash: TX_A, transactionHashes: [TX_A, TX_B] });
    // Request 1 (the DROPPED), 2 (the FAILED observation) and 3 (the late contradiction).
    expect(reconciler.requests).toHaveLength(3);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("10");
  });
});

// ----------------------------------------------------------------- R2-03 --

describe("WP300-R2-03: every identifier an operation depends on is valid before it is accepted; confirmation never wedges", () => {
  it("the verifier's reproduction: the reservation id fits (506) but the derived debit id would not (517); refused at plan time", async () => {
    // Asset ids "p", "y", "n" as in the verifier's report.
    const created = AssetRegistry.create({ pusdAssetId: "p" });
    if (!created.ok) throw new Error(created.refusal.message);
    created.value.registerOutcomePair({ conditionId: CONDITION, yesAssetId: "y", noAssetId: "n" });
    const book = new InventoryBook(created.value);
    book.observeActual({ accountRef: ACCOUNT, assetId: "p", balance: "100" });
    const executor = new ScriptedExecutor(() => Promise.resolve({ status: "SUBMITTED", transactionHash: TX_A, transactionId: null }));
    const reconciler = new Reconciler();
    const manager = new WalletOperationManager({ requestToken: requestTokens(), book, approvals: new ApprovalTracker(), executor, reconciler });
    const id = "x".repeat(485);
    expect(key("wallet-op", id, "p")).toHaveLength(506);
    expect(key(key("wallet-op", id, "p"), "out")).toHaveLength(517);

    const planned = manager.plan(split(id, "10"));
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refusal.code).toBe("INVENTORY_INVALID_INPUT");
    expect(book.line(ACCOUNT, "p")).toMatchObject({ reserved: "0", available: "100" });
    // Nothing exists to submit, so nothing can wedge.
    const submitted = await manager.submit(id);
    expect(submitted.ok).toBe(false);
    expect(executor.submitted).toEqual([]);
  });

  it("control: the longest accepted operationId plans, submits and confirms with its effects applied", async () => {
    const { book, manager, reconciler } = harness();
    expect(MAX_IDENTIFIER_LENGTH).toBe(512);
    let length = 512;
    while (length > 0 && !manager.plan(split("x".repeat(length), "10")).ok) length -= 1;
    const id = "x".repeat(length);
    expect(length).toBeGreaterThan(400);
    await manager.submit(id);
    manager.observe(id, { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(manager.operation(id)).toMatchObject({ state: "CONFIRMED", effectsApplied: true });
    expect(book.line(ACCOUNT, YES)?.actual).toBe("10");
    expect(reconciler.requests).toEqual([]);
  });

  it("a confirmation the book cannot record takes the recovery path: lines await a read, holds end, reconciliation is asked", async () => {
    const { book, manager, reconciler } = harness();
    const planned = manager.plan(split("s", "10"));
    await manager.submit("s");
    // Another caller releases the operation's reservation (ids are public).
    const reservationId = planned.ok ? planned.value.reservationIds[0] : undefined;
    expect(book.release({ reservationId: reservationId ?? "" }).ok).toBe(true);
    expect(() => manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null })).not.toThrow();
    expect(manager.operation("s")).toMatchObject({ state: "CONFIRMED", effectsApplied: false });
    expect(book.line(ACCOUNT, YES)?.blocked).toBe("AWAITING_OBSERVATION");
    expect(reconciler.requests).toEqual([expect.objectContaining({ trigger: "POSITION_BALANCE_DISCREPANCY" })]);
    // Recovery: the hold has ended, so an authoritative read is accepted and unblocks the line.
    expect(book.observeActual({ accountRef: ACCOUNT, assetId: YES, balance: "10" }).ok).toBe(true);
    expect(book.line(ACCOUNT, YES)).toMatchObject({ actual: "10", blocked: null });
  });

  it("a derived credit pending id already taken is the same recovery path, not an exception", async () => {
    const { book, manager } = harness();
    manager.plan(split("s", "10"));
    await manager.submit("s");
    expect(book.expectInflow({ pendingId: key("wallet-op", "s", NO, "in"), accountRef: ACCOUNT, assetId: NO, amount: "1" }).ok).toBe(true);
    expect(() => manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null })).not.toThrow();
    expect(manager.operation("s")).toMatchObject({ state: "CONFIRMED", effectsApplied: false });
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ reserved: "0", blocked: "AWAITING_OBSERVATION" });
  });

  it("a hold the book refuses is refused at submit, before the executor is called; the operation stays submittable", async () => {
    const { book, manager, executor } = harness();
    manager.plan(split("s", "10"));
    expect(book.holdForOperation({ holdId: key("wallet-op", "s"), accountRef: ACCOUNT, assetIds: [PUSD] }).ok).toBe(true);
    const refused = await manager.submit("s");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.refusal.code).toBe("INVENTORY_DUPLICATE_HOLD_ID");
    expect(executor.submitted).toEqual([]);
    expect(manager.operation("s")).toMatchObject({ state: "PLANNED", submitting: false });
    book.releaseOperationHold(key("wallet-op", "s"));
    expect((await manager.submit("s")).ok).toBe(true);
    expect(manager.operation("s")?.state).toBe("SUBMITTED");
  });
});
