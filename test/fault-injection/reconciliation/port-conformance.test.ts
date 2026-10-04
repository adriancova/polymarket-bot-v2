/**
 * WP-290: the coordinator's structural ports are satisfied by the real
 * implementations, and its mirrors equal their originals. `packages/oms` may
 * not import `packages/ledger`, `packages/inventory` (same layer, no §2.1
 * row) or `packages/polymarket-secure` (layer 2), so these shapes are
 * mirrored in `packages/oms/src/reconciliation/ports.ts`; this file is the
 * proof, at compile time (the suite's script typechecks it first) and, where
 * a value exists, at run time.
 */

import { describe, expect, it } from "vitest";

import {
  WALLET_OPERATION_STATES,
  type ReconciliationRequest as InventoryRequest,
  type ReconciliationRequester as InventoryRequester,
  type WalletOperationManager,
  type WalletOperationState,
} from "../../../packages/inventory/src/index.js";
import {
  BREAK_CLASSES,
  BREAK_TAXONOMY,
  type BreakClass as LedgerBreakClass,
  type BreakRule as LedgerBreakRule,
  type ReconciliationBreakView,
  type ReconciliationJournal,
  type ReconciliationJournalInput,
  type ReconciliationTrigger as LedgerTrigger,
} from "../../../packages/ledger/src/index.js";
import type {
  JournalBreakView,
  JournalInput,
  OrderManager,
  ReconciledOms,
  ReconciledUserStream,
  ReconciledWalletOperations,
  ReconciliationBreakClass,
  ReconciliationBreakRule,
  ReconciliationJournalPort,
  ReconciliationRequester as OmsRequester,
  ReconciliationTrigger,
  StreamReconciliationRequest,
  WalletReconciliationRequest,
} from "../../../packages/oms/src/index.js";
import { RECONCILED_WALLET_OPERATION_STATES, VENUE_TRADE_STATUSES, type ReconciledWalletOperationState } from "../../../packages/oms/src/reconciliation/ports.js";
import { STREAM_ACTIVITY_KEYS, STREAM_OUTPUT_KINDS } from "../../../packages/oms/src/reconciliation/door.js";
import {
  USER_TRADE_STATUSES,
  type UserStreamManager,
  type UserStreamOutput,
  type UserStreamReconciliationRequest,
} from "../../../packages/polymarket-secure/src/user-stream/index.js";

import { boot, universe } from "./support/harness.js";

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

// The mirrors equal their originals.
const breakClassesEqual: Equal<ReconciliationBreakClass, LedgerBreakClass> = true;
const breakRulesEqual: Equal<ReconciliationBreakRule, LedgerBreakRule> = true;
const triggersEqual: Equal<ReconciliationTrigger, LedgerTrigger> = true;
// (r13, the closed-vocabulary audit) The closed vocabularies the doors and the coordinator read against: WP-280's five
// outputs, the keys only its ORDER and TRADE outputs carry, and WP-300's seven wallet operation states.
const streamKindsEqual: Equal<(typeof STREAM_OUTPUT_KINDS)[number], UserStreamOutput["kind"]> = true;
type NonActivityOutput = Exclude<UserStreamOutput, { readonly kind: "ORDER" | "TRADE" }>;
type ActivityOutput = Extract<UserStreamOutput, { readonly kind: "ORDER" | "TRADE" }>;
const activityKeysOnActivity: Equal<Extract<(typeof STREAM_ACTIVITY_KEYS)[number], keyof ActivityOutput>, (typeof STREAM_ACTIVITY_KEYS)[number]> = true;
const activityKeysNotElsewhere: Equal<Extract<(typeof STREAM_ACTIVITY_KEYS)[number], NonActivityOutput extends infer O ? (O extends unknown ? keyof O : never) : never>, never> = true;
const walletStatesEqual: Equal<ReconciledWalletOperationState, WalletOperationState> = true;

// The journal's input is the same union in both packages (assignable both ways).
const journalInputIn = (event: JournalInput): ReconciliationJournalInput => event;
const journalInputOut = (event: ReconciliationJournalInput): JournalInput => event;
const breakViewOut = (view: ReconciliationBreakView): JournalBreakView => view;

// The real implementations satisfy the ports.
const omsPort = (oms: OrderManager): ReconciledOms => oms;
const journalPort = (journal: ReconciliationJournal): ReconciliationJournalPort => journal;
const walletPort = (wallet: WalletOperationManager): ReconciledWalletOperations => wallet;
const streamPort = (stream: UserStreamManager): ReconciledUserStream => stream;

// The requests: what the inventory and WP-280 issue is what the coordinator reads, and the coordinator's
// requesters are what the OMS and the inventory call.
const inventoryRequest = (request: InventoryRequest): WalletReconciliationRequest => request;
const streamRequest = (request: UserStreamReconciliationRequest): StreamReconciliationRequest => request;
const walletRequester = (requester: { request(request: WalletReconciliationRequest): void }): InventoryRequester => requester;
const omsRequester = (requester: OmsRequester): OmsRequester => requester;

describe("the coordinator's ports and mirrors", () => {
  it("are pinned at compile time (the typecheck of this file is the proof)", () => {
    expect([breakClassesEqual, breakRulesEqual, triggersEqual]).toEqual([true, true, true]);
    expect([journalInputIn, journalInputOut, breakViewOut, omsPort, journalPort, walletPort, streamPort, inventoryRequest, streamRequest, walletRequester, omsRequester].every((check) => typeof check === "function")).toBe(true);
  });

  it("(r13) the closed vocabularies are pinned to their producers': WP-280's outputs and settlement statuses, WP-300's wallet operation states (at compile time above, and at run time here)", () => {
    expect([streamKindsEqual, activityKeysOnActivity, activityKeysNotElsewhere, walletStatesEqual]).toEqual([true, true, true, true]);
    expect([...RECONCILED_WALLET_OPERATION_STATES].sort()).toEqual([...WALLET_OPERATION_STATES].sort());
    expect([...VENUE_TRADE_STATUSES].sort()).toEqual([...USER_TRADE_STATUSES].sort());
    expect([...STREAM_OUTPUT_KINDS].sort()).toEqual(["ORDER", "RECONCILIATION_REQUESTED", "STATE", "TRADE", "UNRECOGNIZED_MESSAGE"]);
    expect([...STREAM_ACTIVITY_KEYS].sort()).toEqual(["event", "oms"]);
  });

  it("at run time: a real OMS opens with the coordinator as its reconciler, and the journal's taxonomy names every class", async () => {
    const u = universe();
    const p = await boot(u);
    expect(p.oms).not.toBeNull();
    expect((await p.coordinator.reconcile()).resumed).toBe(true);
    for (const breakClass of BREAK_CLASSES) expect(p.journal.ruleOf(breakClass)).toBe(BREAK_TAXONOMY[breakClass].rule);
  });

  it("the coordinator refuses to be built without a policy value (no default: the horizon needs an ADR)", async () => {
    const u = universe();
    const p = await boot(u);
    const { ReconciliationCoordinator } = await import("../../../packages/oms/src/index.js");
    const deps = {
      reads: {} as never,
      journal: p.journal,
      holdings: {} as never,
      halts: {} as never,
      clock: { now: () => 0 },
      newId: () => "",
      marketOfToken: () => null,
      tokenOfGroup: () => null,
    };
    for (const policy of [
      { ...u.policy, quiescenceHorizonMs: 0 },
      { ...u.policy, quiescenceHorizonMs: 1.5 },
      { ...u.policy, maxReadSpanMs: undefined },
      { ...u.policy, holdingConfirmationMs: -1 },
      { ...u.policy, accountRef: "" },
    ]) {
      expect(() => new ReconciliationCoordinator({ ...deps, policy: policy as never }), JSON.stringify(policy)).toThrow(TypeError);
    }
  });
});
