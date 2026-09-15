/**
 * THE FOUR LEDGER KEYS DO NOT DEPEND ON AN INHERITED `toJSON` (`SER-1`).
 *
 * MEASURED AT `main` `d6e05bf` (`SER-0`, reproduced independently), with the
 * array literal each key site builds reaching `JSON.stringify`, which resolves
 * `toJSON` through the prototype chain:
 *
 * ```text
 * balance.ts     attributionBucketKey   every (account, asset) bucket collapsed to ONE key;
 *                                       the cross-account parity breach (A -5 unattributed,
 *                                       B +5) was ACCEPTED where clean refuses
 *                                       LEDGER_ATTRIBUTION_PARITY_BROKEN, and the
 *                                       partition audit reported nothing
 * balance.ts     legKeyOfValidated      all legs under ONE key netted to zero, so
 *                                       isExactNegation(empty, empty) was true: a partial
 *                                       "reversal" and a wrong-account "reversal" were both
 *                                       ACCEPTED as exact compensations
 * projections.ts balanceLineKey         every entry landed on one zero-sum line and the
 *                                       zero-drop deleted it: the balance book was EMPTY
 * projections.ts virtualPositionKey     both instances' positions folded into ONE line
 * projections.ts stableStringify        an out-of-type bigint flipped from a TypeError to
 *                                       accepted "INJECTED" bytes (oracle only)
 * ```
 *
 * in four of the six contexts (the BigInt contexts leave string-only keys
 * alone). Each `it` below runs its scenarios clean and then under ALL SIX
 * contexts and requires (a) every answer byte-identical to the clean one and
 * (b) the injected `toJSON` invoked ZERO times — so it fails at the base
 * commit and passes once the keys are built by `encodePlainJson`
 * (`@polymarket-bot/risk/plain-json`). The base failure was reproduced in the
 * implementing worktree by reverting the four source edits (handoff).
 *
 * The scenarios render their answers WITHOUT `JSON.stringify` — that is the
 * function under suspicion — and assert nothing inside the polluted window.
 */

import { describe, expect, it } from "vitest";

import {
  Ledger,
  applyTransaction,
  attributionBucketKey,
  auditAttributionPartition,
  emptyProjection,
  legKey,
  projectLedger,
  serializeLedger,
  serializeProjection,
  validateTransactionInput,
  virtualPositions,
} from "../../../packages/ledger/src/index.js";
import type { LedgerProjection, LedgerTransactionInput } from "../../../packages/ledger/src/index.js";
import {
  ACCOUNT,
  ATTRIBUTION_CLEARING,
  INSTANCE_A,
  INSTANCE_B,
  OTHER_ACCOUNT,
  PUSD,
  VENUE_CLEARING,
  collateral,
  reattribute,
  transaction,
  tx,
  unattributedDeposit,
} from "../../../packages/ledger/src/testing/scenarios.js";
import { renderDivergences, sweepInheritedToJson } from "./inherited-tojson.js";
import type { ToJsonScenario } from "./inherited-tojson.js";

// ---------------------------------------------------------------------------
// Renderers (no JSON.stringify anywhere below this line)
// ---------------------------------------------------------------------------

function appendOutcome(ledger: Ledger, input: LedgerTransactionInput): string {
  const result = ledger.append(input);
  if (result.ok) return `OK length=${String(result.value.ledger.length)}`;
  const codes = result.refusals.map((refusal) => refusal.code).sort().join(",");
  const parity = result.refusals
    .filter((refusal) => refusal.code === "LEDGER_ATTRIBUTION_PARITY_BROKEN")
    .map((refusal) => {
      const details = refusal.details as Record<string, unknown>;
      return `${String(details["accountRef"])}/${String(details["assetId"])}:${String(details["actualDelta"])}vs${String(details["attributedDelta"])}`;
    })
    .join(";");
  return `REFUSED ${codes}${parity === "" ? "" : ` [${parity}]`}`;
}

function appended(ledger: Ledger, input: LedgerTransactionInput): Ledger {
  const result = ledger.append(input);
  if (!result.ok) throw new Error(`fixture refused: ${result.refusals.map((refusal) => refusal.code).join(",")}`);
  return result.value.ledger;
}

function renderBalances(projection: LedgerProjection): string {
  const lines = [...projection.balances.entries()]
    .map(([key, line]) => `${key}=>${line.scope}|${line.accountRef}|${line.assetId}|${line.assetKind}|${line.balance}`)
    .sort();
  return `count=${String(projection.transactionCount)} balances=${String(lines.length)} ${lines.join(" ; ")}`;
}

function renderPositions(projection: LedgerProjection): string {
  const lines = virtualPositions(projection).map(
    (line) => `${line.instanceId}|${line.assetId}|${line.assetKind}|${String(line.marketId)}|${line.balance}`,
  );
  const keys = [...projection.virtualPositions.keys()].sort().join(" ; ");
  return `lines=${String(lines.length)} ${lines.join(" ; ")} keys=${keys}`;
}

function foldExternal(input: LedgerTransactionInput): LedgerProjection {
  const validated = validateTransactionInput(input);
  if (!validated.ok) throw new Error("fixture is not a well-formed transaction");
  return applyTransaction(emptyProjection(), { sequence: 0, transaction: validated.value });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The reviewer's cross-account counterexample (`attribution-granularity.test.ts`). */
const CROSS_ACCOUNT_ARRIVAL = transaction({
  ledgerTransactionId: tx(1),
  eventType: "MANUAL_ADJUSTMENT",
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "-5"),
    collateral("ACTUAL_ACCOUNT", OTHER_ACCOUNT, "5"),
    collateral("VIRTUAL_STRATEGY", OTHER_ACCOUNT, "-5", { instanceId: INSTANCE_A }),
    collateral("UNATTRIBUTED", OTHER_ACCOUNT, "5"),
  ],
});

const ORIGINAL = transaction({
  ledgerTransactionId: tx(1),
  eventType: "TRADE_PRINCIPAL",
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "-10"),
    collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "10"),
    collateral("UNATTRIBUTED", ACCOUNT, "-10"),
    collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "10"),
  ],
});

const EXACT_REVERSAL = transaction({
  ledgerTransactionId: tx(2),
  eventType: "RECONCILIATION_CORRECTION",
  reversesLedgerTransactionId: tx(1),
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "10"),
    collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-10"),
    collateral("UNATTRIBUTED", ACCOUNT, "10"),
    collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-10"),
  ],
});

const PARTIAL_REVERSAL = transaction({
  ledgerTransactionId: tx(2),
  reversesLedgerTransactionId: tx(1),
  entries: [
    collateral("ACTUAL_ACCOUNT", ACCOUNT, "6"),
    collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-6"),
    collateral("UNATTRIBUTED", ACCOUNT, "6"),
    collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-6"),
  ],
});

const WRONG_ACCOUNT_REVERSAL = transaction({
  ledgerTransactionId: tx(2),
  reversesLedgerTransactionId: tx(1),
  entries: [
    collateral("ACTUAL_ACCOUNT", OTHER_ACCOUNT, "10"),
    collateral("EXTERNAL_CLEARING", VENUE_CLEARING, "-10"),
    collateral("UNATTRIBUTED", OTHER_ACCOUNT, "10"),
    collateral("EXTERNAL_CLEARING", ATTRIBUTION_CLEARING, "-10"),
  ],
});

/** A short honest history: a deposit, re-attributed to two instances. */
function history(): Ledger {
  let ledger = Ledger.empty("PAPER");
  ledger = appended(ledger, unattributedDeposit(tx(1), "100"));
  ledger = appended(ledger, reattribute(tx(2), "30", INSTANCE_A));
  ledger = appended(ledger, reattribute(tx(3), "20", INSTANCE_B));
  return ledger;
}

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

describe("attributionBucketKey: the parity decision is invariant under an inherited toJSON", () => {
  const scenarios: readonly ToJsonScenario[] = [
    { name: "bucket key bytes", render: () => attributionBucketKey(ACCOUNT, PUSD) },
    { name: "two accounts stay two buckets", render: () => `${attributionBucketKey(ACCOUNT, PUSD)}|${attributionBucketKey(OTHER_ACCOUNT, PUSD)}` },
    { name: "Ledger.append refuses the cross-account breach", render: () => appendOutcome(Ledger.empty("PAPER"), CROSS_ACCOUNT_ARRIVAL) },
    {
      name: "auditAttributionPartition sees the breach in externally folded history",
      render: () => {
        const violations = auditAttributionPartition(foldExternal(CROSS_ACCOUNT_ARRIVAL));
        return `violations=${String(violations.length)} ${violations
          .map((violation) => `${violation.accountRef}/${violation.assetId}`)
          .sort()
          .join(",")}`;
      },
    },
  ];

  it("refuses LEDGER_ATTRIBUTION_PARITY_BROKEN identically in all six contexts, with toJSON run 0 times", () => {
    const { clean, divergences } = sweepInheritedToJson(scenarios);
    expect(renderDivergences(divergences)).toEqual([]);
    // The clean answers are the ones the door is supposed to give — so the pin
    // is about a real refusal, not about two empty answers agreeing.
    expect(clean.get("bucket key bytes")).toBe(`ok:["${ACCOUNT}","${PUSD}"]`);
    expect(clean.get("Ledger.append refuses the cross-account breach")).toBe(
      `ok:REFUSED LEDGER_ATTRIBUTION_PARITY_BROKEN,LEDGER_ATTRIBUTION_PARITY_BROKEN [${ACCOUNT}/${PUSD}:-5vs0;${OTHER_ACCOUNT}/${PUSD}:5vs0]`,
    );
    expect(clean.get("auditAttributionPartition sees the breach in externally folded history")).toBe(
      `ok:violations=2 ${ACCOUNT}/${PUSD},${OTHER_ACCOUNT}/${PUSD}`,
    );
  });
});

describe("legKeyOfValidated: the compensating-reversal decision is invariant under an inherited toJSON", () => {
  const scenarios: readonly ToJsonScenario[] = [
    {
      name: "leg key bytes",
      render: () => legKey({ scope: "UNATTRIBUTED", accountRef: ACCOUNT, assetId: PUSD }),
    },
    {
      name: "a partial reversal is refused",
      render: () => appendOutcome(appended(Ledger.empty("PAPER"), ORIGINAL), PARTIAL_REVERSAL),
    },
    {
      name: "a wrong-account reversal is refused",
      render: () => appendOutcome(appended(Ledger.empty("PAPER"), ORIGINAL), WRONG_ACCOUNT_REVERSAL),
    },
    {
      name: "an exact reversal is still accepted (the pin is not fail-closed-by-accident)",
      render: () => appendOutcome(appended(Ledger.empty("PAPER"), ORIGINAL), EXACT_REVERSAL),
    },
  ];

  it("refuses LEDGER_REVERSAL_NOT_COMPENSATING identically in all six contexts, with toJSON run 0 times", () => {
    const { clean, divergences } = sweepInheritedToJson(scenarios);
    expect(renderDivergences(divergences)).toEqual([]);
    expect(clean.get("leg key bytes")).toBe(`ok:["UNATTRIBUTED","${ACCOUNT}",null,"${PUSD}"]`);
    expect(clean.get("a partial reversal is refused")).toBe("ok:REFUSED LEDGER_REVERSAL_NOT_COMPENSATING");
    expect(clean.get("a wrong-account reversal is refused")).toBe("ok:REFUSED LEDGER_REVERSAL_NOT_COMPENSATING");
    expect(clean.get("an exact reversal is still accepted (the pin is not fail-closed-by-accident)")).toBe("ok:OK length=2");
  });
});

describe("balanceLineKey: the projected balance book is invariant under an inherited toJSON", () => {
  const scenarios: readonly ToJsonScenario[] = [
    { name: "projectLedger balance book", render: () => renderBalances(projectLedger(history())) },
    {
      name: "the same book folded from external history",
      render: () => renderBalances(foldExternal(unattributedDeposit(tx(1), "100"))),
    },
  ];

  it("keeps every balance line, with toJSON run 0 times", () => {
    const { clean, divergences } = sweepInheritedToJson(scenarios);
    expect(renderDivergences(divergences)).toEqual([]);
    // Non-vacuity: the clean book is NOT empty — an empty book is exactly the
    // measured failure (every line under one key nets to zero and is dropped).
    const book = clean.get("projectLedger balance book") ?? "";
    expect(book.startsWith("ok:count=3 balances=5 ")).toBe(true);
    expect(book).toContain(`["ACTUAL_ACCOUNT","${ACCOUNT}","${PUSD}"]=>ACTUAL_ACCOUNT|${ACCOUNT}|${PUSD}|COLLATERAL|100`);
    expect(book).toContain(`["UNATTRIBUTED","${ACCOUNT}","${PUSD}"]=>UNATTRIBUTED|${ACCOUNT}|${PUSD}|COLLATERAL|50`);
    expect(clean.get("the same book folded from external history")?.startsWith("ok:count=1 balances=4 ")).toBe(true);
  });
});

describe("virtualPositionKey: per-instance positions are invariant under an inherited toJSON", () => {
  const scenarios: readonly ToJsonScenario[] = [
    { name: "virtualPositions of two instances", render: () => renderPositions(projectLedger(history())) },
  ];

  it("keeps one line per instance, with toJSON run 0 times", () => {
    const { clean, divergences } = sweepInheritedToJson(scenarios);
    expect(renderDivergences(divergences)).toEqual([]);
    // Non-vacuity: two instances, two lines, two keys — the measured failure
    // folded both into one line carrying the arithmetic sum.
    expect(clean.get("virtualPositions of two instances")).toBe(
      `ok:lines=2 ${INSTANCE_A}|${PUSD}|COLLATERAL|null|30 ; ${INSTANCE_B}|${PUSD}|COLLATERAL|null|20 ` +
        `keys=["${INSTANCE_A}","${PUSD}"] ; ["${INSTANCE_B}","${PUSD}"]`,
    );
  });
});

describe("stableStringify (serializeProjection / serializeLedger): the oracle bytes are invariant under an inherited toJSON", () => {
  const scenarios: readonly ToJsonScenario[] = [
    { name: "serializeProjection", render: () => serializeProjection(projectLedger(history())) },
    { name: "serializeLedger", render: () => serializeLedger(history()) },
    {
      // The out-of-type route `SER-0` measured on the scalar branch: a bigint in
      // the tree is a typed refusal in every context, never accepted bytes.
      name: "an out-of-type bigint is refused, not encoded",
      render: () => serializeProjection({ ...emptyProjection(), transactionCount: 1n as never }),
    },
  ];

  it("emits the same bytes in all six contexts, with toJSON run 0 times, and refuses a bigint typed", () => {
    const { clean, divergences } = sweepInheritedToJson(scenarios);
    expect(renderDivergences(divergences)).toEqual([]);
    expect(clean.get("serializeProjection")?.startsWith("ok:polymarket-bot/ledger-projection/")).toBe(true);
    expect(clean.get("serializeLedger")?.startsWith("ok:polymarket-bot/ledger/")).toBe(true);
    expect(clean.get("an out-of-type bigint is refused, not encoded")).toBe(
      "threw:value: a bigint has no JSON representation",
    );
  });
});
