/**
 * WP-300 remediation round 4: pins for the verifier's finding WP300-R4-01
 * ("Terminal operations can retain unresolved transaction evidence while
 * inventory becomes spendable"). Each pin fails against the round-3 candidate
 * (04e1c18) and passes after the fix; controls are marked as such.
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
import { ACCOUNT, CONDITION, NO, PUSD, USDC_E, YES, seededBook } from "./helpers.js";

const TX_A = "0x00000000000000000000000000000000000000000000000000000000000000a1";
const TX_B = "0x00000000000000000000000000000000000000000000000000000000000000b2";
const TX_C = "0x00000000000000000000000000000000000000000000000000000000000000c3";

class Reconciler {
  readonly requests: ReconciliationRequest[] = [];
  request(request: ReconciliationRequest): void {
    this.requests.push(request);
  }
}

function harness(answer: unknown, balances: Readonly<Record<string, string>> = { [PUSD]: "100" }) {
  const book = seededBook(balances);
  const reconciler = new Reconciler();
  const executor: WalletOperationExecutor = { submit: () => Promise.resolve(answer) };
  const manager = new WalletOperationManager({ book, approvals: new ApprovalTracker(), executor, reconciler });
  return { book, reconciler, manager };
}

const SUBMITTED_A = { status: "SUBMITTED", transactionHash: TX_A, transactionId: null };

/** A SPLIT of 10 pUSD submitted under transaction A. */
async function splitSubmittedUnderA() {
  const h = harness(SUBMITTED_A);
  expect(h.manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" }).ok).toBe(
    true,
  );
  await h.manager.submit("s");
  expect(h.manager.operation("s")?.state).toBe("SUBMITTED");
  return h;
}

const reserve = (book: ReturnType<typeof seededBook>, amount: string, id: string, assetId = PUSD) =>
  book.reserve({ reservationId: id, holderRef: `holder-${id}`, accountRef: ACCOUNT, assetId, amount });

const read = (book: ReturnType<typeof seededBook>, assetId: string, balance: string) =>
  book.observeActual({ accountRef: ACCOUNT, assetId, balance });

const authoritative = (state: string, transactionHash: string | null, transactionId: string | null = null) => ({
  source: "AUTHORITATIVE_READ",
  state,
  transactionHash,
  transactionId,
});

// ----------------------------------------------------------------- R4-01 --

describe("WP300-R4-01: contested terminal evidence quarantines the lines; a balance read cannot lift it", () => {
  it("the verifier's first reproduction: FAILED(A), then SUBMITTED(B), a read, and CONFIRMED(B) never make the balance spendable", async () => {
    const { book, manager, reconciler } = await splitSubmittedUnderA();
    expect(manager.observe("s", { status: "FAILED", transactionHash: TX_A, transactionId: null }).ok).toBe(true);
    expect(manager.operation("s")?.state).toBe("FAILED");
    expect(book.line(ACCOUNT, PUSD)).toMatchObject({ actual: "100", reserved: "0", blocked: null });

    // Step 2: SUBMITTED(B) after the terminal state.
    expect(manager.observe("s", { status: "SUBMITTED", transactionHash: TX_B, transactionId: null }).ok).toBe(false);

    // Step 3: a balance read while B is unresolved is accepted but does NOT lift the protection.
    expect(read(book, PUSD, "100").ok).toBe(true);

    // Step 4 (the decisive one): nothing on the line is spendable.
    expect(reserve(book, "100", "all").ok).toBe(false);
    expect(reserve(book, "1", "one").ok).toBe(false);
    expect(book.line(ACCOUNT, PUSD)?.reserved).toBe("0");

    // How: a quarantine on every touched line, and one request naming B.
    for (const asset of [PUSD, YES, NO]) expect(book.line(ACCOUNT, asset)?.blocked).toBe("QUARANTINED");
    expect(book.isQuarantined(ACCOUNT, PUSD)).toBe(true);
    expect(reconciler.requests).toEqual([
      expect.objectContaining({
        trigger: "POSITION_BALANCE_DISCREPANCY",
        walletOperationId: "s",
        unresolvedTransactions: [`hash:${TX_B}`],
        transactionHashes: [TX_A, TX_B],
      }),
    ]);
    expect(manager.operation("s")).toMatchObject({ state: "FAILED", quarantined: true, unresolvedTransactions: [`hash:${TX_B}`] });

    // Step 5: CONFIRMED(B) is refused as a transition; the quarantine stays (already contested: no duplicate request).
    expect(manager.observe("s", { status: "CONFIRMED", transactionHash: TX_B, transactionId: null }).ok).toBe(false);
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("QUARANTINED");
    expect(reconciler.requests).toHaveLength(1);

    // The authoritative recovery path: B resolved by name.
    const resolved = manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_B));
    expect(resolved.ok).toBe(true);
    expect(manager.operation("s")).toMatchObject({ state: "FAILED", quarantined: false, unresolvedTransactions: [] });
    expect(book.isQuarantined(ACCOUNT, PUSD)).toBe(false);
    // B's effect was never applied: the lines await a fresh authoritative read.
    for (const asset of [PUSD, YES, NO]) expect(book.line(ACCOUNT, asset)?.blocked).toBe("AWAITING_OBSERVATION");
    expect(reserve(book, "1", "one-b").ok).toBe(false);
    expect(read(book, PUSD, "90").ok).toBe(true);
    expect(reserve(book, "90.000001", "too-much").ok).toBe(false);
    expect(reserve(book, "90", "ninety").ok).toBe(true);
  });

  it("the verifier's second reproduction: SUBMITTED(A) → FAILED(A) → CONFIRMED(A) is contradictory and quarantines hash:A", async () => {
    const { book, manager, reconciler } = await splitSubmittedUnderA();
    manager.observe("s", { status: "FAILED", transactionHash: TX_A, transactionId: null });
    expect(manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null }).ok).toBe(false);
    expect(reserve(book, "100", "all").ok).toBe(false);
    expect(read(book, PUSD, "100").ok).toBe(true);
    expect(reserve(book, "100", "all-2").ok).toBe(false);
    expect(reconciler.requests).toEqual([
      expect.objectContaining({ trigger: "POSITION_BALANCE_DISCREPANCY", unresolvedTransactions: [`hash:${TX_A}`] }),
    ]);
    expect(manager.operation("s")).toMatchObject({ state: "FAILED", quarantined: true, unresolvedTransactions: [`hash:${TX_A}`] });
    // Recovery: the authority confirms FAILED(A); the lines then await a read.
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_A)).ok).toBe(true);
    expect(manager.operation("s")?.quarantined).toBe(false);
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("AWAITING_OBSERVATION");
    expect(read(book, PUSD, "100").ok).toBe(true);
    expect(reserve(book, "100", "all-3").ok).toBe(true);
  });

  it("the reverse contradiction: CONFIRMED(A) with deltas applied, then FAILED(A), quarantines every touched line", async () => {
    const { book, manager, reconciler } = await splitSubmittedUnderA();
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    expect(book.line(ACCOUNT, YES)?.actual).toBe("10");
    expect(reserve(book, "10", "yes", YES).ok).toBe(true);
    expect(book.release({ reservationId: "yes" }).ok).toBe(true);
    expect(manager.observe("s", { status: "FAILED", transactionHash: TX_A, transactionId: null }).ok).toBe(false);
    for (const asset of [PUSD, YES, NO]) expect(book.line(ACCOUNT, asset)?.blocked).toBe("QUARANTINED");
    expect(reserve(book, "10", "yes-2", YES).ok).toBe(false);
    expect(reconciler.requests).toHaveLength(1);
    expect(manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A)).ok).toBe(true);
    expect(book.line(ACCOUNT, YES)?.blocked).toBe("AWAITING_OBSERVATION");
  });

  it("a CONFIRMED repeat with a different credited amount contests the applied credit", async () => {
    const { book, manager } = harness(SUBMITTED_A, { [USDC_E]: "50" });
    expect(manager.plan({ type: "WRAP_COLLATERAL", operationId: "w", accountRef: ACCOUNT, amount: "10" }).ok).toBe(true);
    await manager.submit("w");
    manager.observe("w", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null, credited: "10" });
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("10");
    // Control: an exact repeat changes nothing.
    manager.observe("w", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null, credited: "10" });
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBeNull();
    manager.observe("w", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null, credited: "12" });
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("QUARANTINED");
    expect(book.line(ACCOUNT, USDC_E)?.blocked).toBe("QUARANTINED");
    expect(manager.operation("w")?.quarantined).toBe(true);
  });

  it("an unrecognised observation after a terminal state contests it (named or not)", async () => {
    for (const observation of [{ status: "DROPPED", transactionHash: TX_A }, { status: "UNKNOWN" }]) {
      const { book, manager, reconciler } = await splitSubmittedUnderA();
      manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
      expect(manager.observe("s", observation).ok).toBe(false);
      expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("QUARANTINED");
      expect(manager.operation("s")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_A}`] });
      expect(reconciler.requests).toHaveLength(1);
    }
  });

  it("an operation that never named a transaction is quarantined under `operation` and resolved by an unnamed answer", async () => {
    const { book, manager, reconciler } = harness({ status: "NOT_SENT" });
    manager.plan({ type: "SPLIT", operationId: "s", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" });
    await manager.submit("s");
    expect(manager.operation("s")?.state).toBe("FAILED");
    // Control: an unnamed FAILED repeat is not a contradiction.
    manager.observe("s", { status: "FAILED" });
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBeNull();
    expect(reconciler.requests).toEqual([]);
    manager.observe("s", { status: "LOST" });
    expect(reserve(book, "1", "one").ok).toBe(false);
    expect(reconciler.requests[0]?.unresolvedTransactions).toEqual(["operation"]);
    expect(manager.operation("s")).toMatchObject({ quarantined: true, unresolvedTransactions: ["operation"] });
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", null)).ok).toBe(true);
    expect(manager.operation("s")?.quarantined).toBe(false);
    expect(read(book, PUSD, "100").ok).toBe(true);
    expect(reserve(book, "100", "all").ok).toBe(true);
  });

  it("a ledger refresh does not lift the quarantine either", async () => {
    const { book, manager } = await splitSubmittedUnderA();
    manager.observe("s", { status: "FAILED", transactionHash: TX_A, transactionId: null });
    manager.observe("s", { status: "MINED", transactionHash: TX_B });
    const refreshed = book.seedFromLedgerBalances(
      [{ scope: "ACTUAL_ACCOUNT", accountRef: ACCOUNT, assetId: PUSD, assetKind: "COLLATERAL", balance: "100" }],
      { accountRefs: [ACCOUNT] },
    );
    expect(refreshed.ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("QUARANTINED");
    expect(reserve(book, "1", "one").ok).toBe(false);
  });

  it("the recovery path refuses non-authoritative, in-flight, unwitnessed, uncontested and contradictory answers", async () => {
    const { book, manager } = await splitSubmittedUnderA();
    manager.observe("s", { status: "FAILED", transactionHash: TX_A, transactionId: null });
    manager.observe("s", { status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    manager.observe("s", { status: "SUBMITTED", transactionHash: TX_C, transactionId: null });
    expect(manager.operation("s")?.unresolvedTransactions).toEqual([`hash:${TX_B}`, `hash:${TX_C}`]);
    const code = (evidence: unknown) => {
      const result = manager.resolveByReconciliation("s", evidence);
      return result.ok ? "ok" : result.refusal.code;
    };
    expect(code({ state: "FAILED", transactionHash: TX_B })).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(code(authoritative("MINED", TX_B))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(code(authoritative("FAILED", "0xdead"))).toBe("WALLET_OP_EVIDENCE_CONFLICT");
    expect(code(authoritative("FAILED", TX_A))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(code(authoritative("FAILED", null))).toBe("WALLET_OP_EVIDENCE_REQUIRED");
    expect(code(authoritative("FAILED", TX_B))).toBe("ok");
    expect(manager.operation("s")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_C}`] });
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("QUARANTINED");
    expect(code(authoritative("CONFIRMED", TX_B))).toBe("WALLET_OP_EVIDENCE_CONFLICT");
    expect(code(authoritative("FAILED", TX_C))).toBe("ok");
    expect(manager.operation("s")?.quarantined).toBe(false);
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("AWAITING_OBSERVATION");
  });

  it("evidence contradicting an authoritative quarantine answer re-opens the quarantine", async () => {
    const { book, manager, reconciler } = await splitSubmittedUnderA();
    manager.observe("s", { status: "FAILED", transactionHash: TX_A, transactionId: null });
    manager.observe("s", { status: "SUBMITTED", transactionHash: TX_B, transactionId: null });
    expect(manager.resolveByReconciliation("s", authoritative("FAILED", TX_B)).ok).toBe(true);
    expect(read(book, PUSD, "100").ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBeNull();
    // Control: a repeat of the authoritative answer changes nothing.
    manager.observe("s", { status: "FAILED", transactionHash: TX_B, transactionId: null });
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBeNull();
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_B, transactionId: null });
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("QUARANTINED");
    expect(manager.operation("s")).toMatchObject({ quarantined: true, unresolvedTransactions: [`hash:${TX_B}`] });
    expect(reconciler.requests).toHaveLength(2);
  });
});

describe("WP300-R4-01 controls: repeats and stale lifecycle reports of a terminal operation change nothing", () => {
  it("control: FAILED(A) repeated, and SUBMITTED(A)/MINED(A) after FAILED(A), neither quarantine nor request", async () => {
    const { book, manager, reconciler } = await splitSubmittedUnderA();
    manager.observe("s", { status: "FAILED", transactionHash: TX_A, transactionId: null });
    for (const observation of [
      { status: "FAILED", transactionHash: TX_A, transactionId: null },
      { status: "SUBMITTED", transactionHash: TX_A, transactionId: null },
      { status: "MINED", transactionHash: TX_A },
    ]) {
      expect(manager.observe("s", observation).ok).toBe(false);
    }
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBeNull();
    expect(reconciler.requests).toEqual([]);
    expect(reserve(book, "100", "all").ok).toBe(true);
    expect(manager.operation("s")?.quarantined).toBe(false);
  });

  it("control: a terminal operation that is not quarantined still refuses reconciliation", async () => {
    const { manager } = await splitSubmittedUnderA();
    manager.observe("s", { status: "CONFIRMED", transactionHash: TX_A, transactionId: null });
    const result = manager.resolveByReconciliation("s", authoritative("CONFIRMED", TX_A));
    expect(result.ok ? "ok" : result.refusal.code).toBe("WALLET_OP_ILLEGAL_TRANSITION");
  });
});

describe("WP300-R4-01: the book's quarantine", () => {
  it("refuses reservations, survives reads, widens under the same id, and is lifted only by its owner", () => {
    const book = seededBook({ [PUSD]: "100", [YES]: "5" });
    expect(book.quarantineLines({ quarantineId: "q", accountRef: ACCOUNT, assetIds: [PUSD] }).ok).toBe(true);
    const refused = reserve(book, "1", "one");
    expect(refused.ok ? null : refused.refusal).toMatchObject({
      code: "INVENTORY_INSUFFICIENT_AVAILABLE",
      details: { blocked: "QUARANTINED" },
    });
    expect(read(book, PUSD, "100").ok).toBe(true);
    expect(book.line(ACCOUNT, PUSD)?.blocked).toBe("QUARANTINED");
    expect(reserve(book, "1", "yes-1", YES).ok).toBe(true);
    expect(book.quarantineLines({ quarantineId: "q", accountRef: ACCOUNT, assetIds: [YES] }).ok).toBe(true);
    expect(book.isQuarantined(ACCOUNT, PUSD)).toBe(true);
    expect(reserve(book, "1", "yes-2", YES).ok).toBe(false);
    expect(book.quarantineLines({ quarantineId: "q", accountRef: "other", assetIds: [PUSD] }).ok).toBe(false);
    expect(book.releaseQuarantine("q")).toBe(true);
    expect(book.releaseQuarantine("q")).toBe(false);
    expect(reserve(book, "100", "all").ok).toBe(true);
    expect(book.checkInvariants()).toEqual([]);
  });
});
