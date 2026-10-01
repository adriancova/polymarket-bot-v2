/**
 * Contract: the sanitized CTF position fixture → the WP-300 wallet-operation
 * state machine.
 *
 * Fixture: `test/fixtures/venue/positions/split-merge-redeem.json` (docs
 * `trading/positions/manage`, retrieved 2026-08-24; re-confirmed UNCHANGED by
 * verified-2026-09-16 §10.2 and verified-2026-09-30 §10.2, "the four frozen
 * addresses … re-confirmed").
 *
 * What is pinned:
 * - the fixture's four contract addresses equal the package's documented
 *   contracts, role for role;
 * - each request's `collateralToken` is the documented pUSD contract, and its
 *   base-unit `amount` converts exactly at pUSD's documented 6 decimals;
 * - split/merge/redeem requests drive the state machine through a MOCK
 *   executor that answers with the fixture's `transaction_outcome` (the SDK
 *   `TransactionOutcome`: `transactionHash`, nullable `transactionId`), and a
 *   null `transactionId` is a legal confirmation;
 * - the neg-risk conversion is recorded, not modelled (ADR-009 §7): no such
 *   operation type exists.
 *
 * OFFLINE: a tripwire replaces `fetch` for every test and fails if it is used.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { divDecimalExact } from "../../../packages/decimal/src/index.js";
import {
  ApprovalTracker,
  AssetRegistry,
  documentedContractAt,
  InventoryBook,
  PUSD_DECIMALS,
  WalletOperationManager,
  type ReconciliationRequest,
  type VenueContractRole,
  type WalletOperationSubmission,
} from "../../../packages/inventory/src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(here, "../../fixtures/venue/positions/split-merge-redeem.json");

interface FixtureExample {
  readonly name: string;
  readonly payload: Record<string, unknown>;
}
const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
  readonly fixture: string;
  readonly sanitized: boolean;
  readonly examples: readonly FixtureExample[];
};

function example(name: string): Record<string, unknown> {
  const found = fixture.examples.find((e) => e.name === name);
  if (found === undefined) throw new Error(`fixture example ${name} missing`);
  return found.payload;
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object") throw new Error("expected an object");
  return value as Record<string, unknown>;
}

/** On-chain base units → decimal pUSD at the documented 6 decimals. */
function fromBaseUnits(amount: string): string {
  return divDecimalExact(amount, `1${"0".repeat(PUSD_DECIMALS)}`);
}

const ACCOUNT = "paper-account-fixture";
const PUSD = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const YES = "fixture-yes-token";
const NO = "fixture-no-token";

let originalFetch: typeof globalThis.fetch;
let fetchCalls = 0;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = 0;
  globalThis.fetch = (() => {
    fetchCalls += 1;
    throw new Error("network tripwire: the wallet-operations contract suite is offline");
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  expect(fetchCalls).toBe(0);
});

function harness(conditionId: string, balances: Readonly<Record<string, string>>, outcome: Record<string, unknown>) {
  const registry = AssetRegistry.create({ pusdAssetId: PUSD });
  if (!registry.ok) throw new Error(registry.refusal.message);
  const pair = registry.value.registerOutcomePair({ conditionId, yesAssetId: YES, noAssetId: NO });
  if (!pair.ok) throw new Error(pair.refusal.message);
  const book = new InventoryBook(registry.value);
  for (const [assetId, balance] of Object.entries(balances)) {
    const observed = book.observeActual({ accountRef: ACCOUNT, assetId, balance });
    if (!observed.ok) throw new Error(observed.refusal.message);
  }
  const submitted: WalletOperationSubmission[] = [];
  const reconciliations: ReconciliationRequest[] = [];
  const manager = new WalletOperationManager({
    book,
    approvals: new ApprovalTracker(),
    executor: {
      submit: (submission) => {
        submitted.push(submission);
        return Promise.resolve({
          status: "SUBMITTED",
          transactionHash: outcome["transactionHash"],
          transactionId: outcome["transactionId"],
        });
      },
    },
    reconciler: { request: (r) => void reconciliations.push(r) },
  });
  return { book, manager, submitted, reconciliations };
}

describe("fixture envelope", () => {
  it("is the sanitized positions fixture", () => {
    expect(fixture.fixture).toBe("positions/split-merge-redeem");
    expect(fixture.sanitized).toBe(true);
  });
});

describe("contract addresses", () => {
  it("the fixture's four addresses are the package's documented contracts, role for role", () => {
    const contracts = record(example("contract-addresses-polygon-snapshot")["contracts"]);
    const expected: Readonly<Record<string, VenueContractRole>> = {
      pUSD: "PUSD_COLLATERAL_TOKEN",
      ConditionalTokens: "CONDITIONAL_TOKENS",
      CtfCollateralAdapter: "CTF_COLLATERAL_ADAPTER",
      NegRiskCtfCollateralAdapter: "NEG_RISK_CTF_COLLATERAL_ADAPTER",
    };
    expect(Object.keys(contracts).sort()).toEqual(Object.keys(expected).sort());
    for (const [name, role] of Object.entries(expected)) {
      const address = contracts[name];
      expect(typeof address).toBe("string");
      expect(documentedContractAt(address as string)?.role, name).toBe(role);
    }
  });

  it("the neg-risk note's adapter is the documented neg-risk adapter, and no conversion operation exists", () => {
    const note = example("neg-risk-conversion-note");
    expect(documentedContractAt(String(note["adapter"]))?.role).toBe("NEG_RISK_CTF_COLLATERAL_ADAPTER");
    const { manager } = harness("c", {}, { transactionHash: "0x01", transactionId: null });
    const result = manager.plan({ type: "NEG_RISK_CONVERT", operationId: "n1", accountRef: ACCOUNT, amount: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe("WALLET_OP_UNSUPPORTED_TYPE");
  });
});

describe("split / merge / redeem requests through the state machine", () => {
  it("split: pUSD collateral, [1,2] partition, 25 000 000 base units = 25 pUSD → 25 YES + 25 NO", async () => {
    const payload = example("split-request-and-outcome");
    const request = record(payload["request"]);
    const outcome = record(payload["transaction_outcome"]);
    expect(request["collateralToken"]).toBe(PUSD);
    expect(request["partition"]).toEqual([1, 2]);
    expect(String(payload["onchain_function"])).toMatch(/^splitPosition\(/);
    const amount = fromBaseUnits(String(request["amount"]));
    expect(amount).toBe("25");
    const conditionId = String(request["conditionId"]);
    const { book, manager, submitted } = harness(conditionId, { [PUSD]: "30" }, outcome);

    expect(manager.plan({ type: "SPLIT", operationId: "split-0501", accountRef: ACCOUNT, conditionId, amount }).ok).toBe(true);
    const sent = await manager.submit("split-0501");
    expect(sent.ok && sent.value).toMatchObject({
      state: "SUBMITTED",
      transactionHash: outcome["transactionHash"],
      transactionId: outcome["transactionId"],
    });
    expect(submitted).toEqual([{ type: "SPLIT", operationId: "split-0501", accountRef: ACCOUNT, conditionId, amount: "25" }]);
    manager.observe("split-0501", { status: "CONFIRMED", ...outcome });
    expect(manager.operation("split-0501")?.state).toBe("CONFIRMED");
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("5");
    expect(book.line(ACCOUNT, YES)?.actual).toBe("25");
    expect(book.line(ACCOUNT, NO)?.actual).toBe("25");
  });

  it("merge: 10 000 000 base units = 10 balanced pairs → 10 pUSD", async () => {
    const payload = example("merge-request-and-outcome");
    const request = record(payload["request"]);
    const outcome = record(payload["transaction_outcome"]);
    expect(request["collateralToken"]).toBe(PUSD);
    expect(String(payload["onchain_function"])).toMatch(/^mergePositions\(/);
    const amount = fromBaseUnits(String(request["amount"]));
    expect(amount).toBe("10");
    const conditionId = String(request["conditionId"]);
    const { book, manager } = harness(conditionId, { [YES]: "10", [NO]: "12" }, outcome);
    expect(manager.plan({ type: "MERGE", operationId: "merge-0502", accountRef: ACCOUNT, conditionId, amount }).ok).toBe(true);
    await manager.submit("merge-0502");
    manager.observe("merge-0502", { status: "CONFIRMED", ...outcome });
    expect(book.line(ACCOUNT, YES)?.actual).toBe("0");
    expect(book.line(ACCOUNT, NO)?.actual).toBe("2");
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("10");
  });

  for (const name of ["redeem-request-and-outcome", "redeem-outcome-null-transaction-id"]) {
    it(`${name}: indexSets [1] redeems YES; the payout is the observed credit; transactionId may be null`, async () => {
      const payload = example(name);
      const request = record(payload["request"]);
      const outcome = record(payload["transaction_outcome"]);
      expect(request["collateralToken"]).toBe(PUSD);
      expect(request["indexSets"]).toEqual([1]);
      expect(String(payload["onchain_function"])).toMatch(/^redeemPositions\(/);
      const conditionId = String(request["conditionId"]);
      const { book, manager, reconciliations } = harness(conditionId, { [YES]: "7" }, outcome);
      expect(
        manager.plan({ type: "REDEEM", operationId: name, accountRef: ACCOUNT, conditionId, resolution: "YES_WIN", yesAmount: "7" }).ok,
      ).toBe(true);
      await manager.submit(name);
      // The fixture's outcome carries no payout amount: the confirmation alone is
      // NOT enough to credit pUSD, so it goes to reconciliation, not to an assumed $1.
      manager.observe(name, { status: "CONFIRMED", ...outcome });
      expect(manager.operation(name)?.state).toBe("RECONCILING");
      expect(reconciliations).toEqual([expect.objectContaining({ trigger: "WALLET_OPERATION_UNKNOWN", walletOperationId: name })]);
      expect(book.line(ACCOUNT, YES)?.actual).toBe("7");
      // An authoritative read resolves it; the lines then await a balance read.
      const resolved = manager.resolveByReconciliation(name, { source: "AUTHORITATIVE_READ", state: "CONFIRMED", ...outcome });
      expect(resolved.ok && resolved.value).toMatchObject({
        state: "CONFIRMED",
        transactionHash: outcome["transactionHash"],
        transactionId: outcome["transactionId"],
      });
      expect(book.line(ACCOUNT, YES)?.blocked).toBe("AWAITING_OBSERVATION");
    });
  }

  it("a confirmation carrying the fixture outcome plus an observed credit settles directly", async () => {
    const payload = example("redeem-outcome-null-transaction-id");
    const request = record(payload["request"]);
    const outcome = record(payload["transaction_outcome"]);
    expect(outcome["transactionId"]).toBeNull();
    const conditionId = String(request["conditionId"]);
    const { book, manager } = harness(conditionId, { [YES]: "7" }, outcome);
    manager.plan({ type: "REDEEM", operationId: "r", accountRef: ACCOUNT, conditionId, resolution: "YES_WIN", yesAmount: "7" });
    await manager.submit("r");
    manager.observe("r", { status: "CONFIRMED", ...outcome, credited: "7" });
    expect(manager.operation("r")).toMatchObject({ state: "CONFIRMED", transactionId: null, effectsApplied: true });
    expect(book.line(ACCOUNT, YES)?.actual).toBe("0");
    expect(book.line(ACCOUNT, PUSD)?.actual).toBe("7");
  });
});
