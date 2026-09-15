/**
 * THE PNL COMPOSITE KEY DOES NOT DEPEND ON AN INHERITED `toJSON` (`SER-1`).
 *
 * MEASURED AT `main` `d6e05bf` (`SER-0`, reproduced independently): `key2`
 * (`pnlCompositeKey`) built `[denominationAsset, scheduleVersionRef]` /
 * `[denominationAsset, programType]` with `JSON.stringify`, which resolves
 * `toJSON` through the prototype chain of that array literal. Under an
 * inherited `Object.prototype`/`Array.prototype` `toJSON` (four of the six
 * contexts) every schedule-versioned fee bucket and every per-program
 * reward/estimate bucket merged into ONE key; `computePnlSnapshot` re-parses
 * the key as a JSON array (`snapshot.ts`, `compositeKeyBelongsTo`), found no
 * array, and the §9.16 breakdown fields — `feesByScheduleVersion`,
 * `rewardsByProgram`, `estimatesByProgram` — came back EMPTY, while
 * `serializePnlState` / `serializeRealizedPnl` produced different bytes. The
 * `stableStringify` scalar branch flipped an out-of-type bigint from a
 * `TypeError` to accepted `"INJECTED"` bytes (oracle only).
 *
 * Each `it` below runs its scenarios clean and then under ALL SIX contexts and
 * requires every answer byte-identical to the clean one with the injected
 * `toJSON` invoked ZERO times — so it fails at the base commit and passes once
 * the key is built by `encodePlainJson` (`@polymarket-bot/risk/plain-json`).
 * The harness and its protocol (install, call, capture a string, restore in a
 * `finally`, assert afterwards; never `JSON.stringify` inside the window) are
 * `test/unit/ledger/inherited-tojson.ts`'s.
 */

import { describe, expect, it } from "vitest";

import {
  computePnlSnapshot,
  emptyPnlState,
  foldPnlRecords,
  pnlCompositeKey,
  serializePnlSnapshots,
  serializePnlState,
  serializeRealizedPnl,
} from "../../../packages/pnl/src/index.js";
import type { PnlSnapshot, PnlState } from "../../../packages/pnl/src/index.js";
import {
  INSTANCE_STREAM,
  PUSD,
  TIMESTAMP,
  USDC,
  YES_TOKEN,
  buy,
  evidenceOf,
  fee,
  rewardEstimate,
  rewardPayout,
  rewardPayoutEvidence,
  sell,
} from "../../../packages/pnl/src/testing/samples.js";
import { renderDivergences, sweepInheritedToJson } from "../ledger/inherited-tojson.js";
import type { ToJsonScenario } from "../ledger/inherited-tojson.js";

// ---------------------------------------------------------------------------
// Fixtures and renderers (no JSON.stringify anywhere below this line)
// ---------------------------------------------------------------------------

/**
 * Two fee schedules in one denomination, a payout and an estimate in two
 * denominations: every composite bucket the state keeps, with at least two
 * keys per bucket so a collapse is visible as a merge, not as a rename.
 */
function fixtureState(): PnlState {
  const result = foldPnlRecords(
    INSTANCE_STREAM,
    [
      buy(1, "10", "0.4"),
      sell(2, "4", "0.6"),
      fee(3, "0.05", "fees-v1"),
      fee(4, "0.02", "fees-v2"),
      { ...fee(5, "0.07"), denominationAsset: USDC },
      rewardPayout(6, "3"),
      rewardEstimate(7, "9"),
      { ...rewardEstimate(8, "11"), denominationAsset: USDC },
    ],
    evidenceOf([rewardPayoutEvidence(6, "3")]),
  );
  if (!result.ok) throw new Error(`fixture refused: ${result.refusals.map((refusal) => refusal.code).join(",")}`);
  return result.value;
}

function renderRecord(record: Readonly<Record<string, string>>): string {
  return Object.keys(record)
    .sort()
    .map((key) => `${key}=${record[key] ?? ""}`)
    .join(";");
}

function renderRows(rows: readonly PnlSnapshot[]): string {
  return rows
    .map(
      (row) =>
        `${row.denominationAsset}{fees:${row.feesPaid}|bySchedule:${renderRecord(row.feesByScheduleVersion)}` +
        `|rewards:${renderRecord(row.rewardsByProgram)}|estimates:${renderRecord(row.estimatesByProgram)}}`,
    )
    .sort()
    .join(" ; ");
}

function snapshotOutcome(state: PnlState): string {
  const result = computePnlSnapshot(state, { asOf: TIMESTAMP, marks: { [YES_TOKEN]: { midpoint: "0.5" } } });
  if (!result.ok) return `REFUSED ${result.refusals.map((refusal) => refusal.code).join(",")}`;
  return `OK rows=${String(result.value.length)} ${renderRows(result.value)}`;
}

function renderBuckets(state: PnlState): string {
  const bucket = (map: ReadonlyMap<string, string>): string =>
    [...map.entries()].map(([key, value]) => `${key}=${value}`).sort().join(",");
  return (
    `feesBySchedule[${bucket(state.feesBySchedule)}] rewardsByProgram[${bucket(state.rewardsByProgram)}] ` +
    `estimatesByProgram[${bucket(state.estimatesByProgram)}]`
  );
}

// ---------------------------------------------------------------------------
// The pins
// ---------------------------------------------------------------------------

describe("pnlCompositeKey (key2): the §9.16 breakdowns are invariant under an inherited toJSON", () => {
  const scenarios: readonly ToJsonScenario[] = [
    { name: "composite key bytes", render: () => pnlCompositeKey(PUSD, "fees-v1") },
    { name: "two schedules stay two keys", render: () => `${pnlCompositeKey(PUSD, "fees-v1")}|${pnlCompositeKey(PUSD, "fees-v2")}` },
    { name: "the folded state's composite buckets", render: () => renderBuckets(fixtureState()) },
    { name: "computePnlSnapshot breakdown fields", render: () => snapshotOutcome(fixtureState()) },
  ];

  it("keeps every schedule-versioned and per-program bucket in all six contexts, with toJSON run 0 times", () => {
    const { clean, divergences } = sweepInheritedToJson(scenarios);
    expect(renderDivergences(divergences)).toEqual([]);
    expect(clean.get("composite key bytes")).toBe(`ok:["${PUSD}","fees-v1"]`);
    // Non-vacuity: the clean state really has two schedule buckets, two
    // program buckets in two denominations, and the snapshot reports them —
    // the measured failure was every one of these fields coming back empty.
    // (Sorted by code unit: `"U"` before `"p"`.)
    expect(clean.get("the folded state's composite buckets")).toBe(
      `ok:feesBySchedule[["${USDC}",""]=0.07,["${PUSD}","fees-v1"]=0.05,["${PUSD}","fees-v2"]=0.02] ` +
        `rewardsByProgram[["${PUSD}","LIQUIDITY_REWARD"]=3] ` +
        `estimatesByProgram[["${USDC}","LIQUIDITY_REWARD"]=11,["${PUSD}","LIQUIDITY_REWARD"]=9]`,
    );
    expect(clean.get("computePnlSnapshot breakdown fields")).toBe(
      `ok:OK rows=2 ${USDC}{fees:0.07|bySchedule:["${USDC}",""]=0.07|rewards:|estimates:["${USDC}","LIQUIDITY_REWARD"]=11} ; ` +
        `${PUSD}{fees:0.07|bySchedule:["${PUSD}","fees-v1"]=0.05;["${PUSD}","fees-v2"]=0.02` +
        `|rewards:["${PUSD}","LIQUIDITY_REWARD"]=3|estimates:["${PUSD}","LIQUIDITY_REWARD"]=9}`,
    );
  });
});

describe("stableStringify (serializePnlState / serializeRealizedPnl / serializePnlSnapshots): the oracle bytes are invariant under an inherited toJSON", () => {
  const scenarios: readonly ToJsonScenario[] = [
    { name: "serializePnlState", render: () => serializePnlState(fixtureState()) },
    { name: "serializeRealizedPnl", render: () => serializeRealizedPnl(fixtureState()) },
    {
      name: "serializePnlSnapshots",
      render: () => {
        const result = computePnlSnapshot(fixtureState(), { asOf: TIMESTAMP, marks: { [YES_TOKEN]: { midpoint: "0.5" } } });
        return result.ok ? serializePnlSnapshots(result.value) : "REFUSED";
      },
    },
    {
      // The out-of-type route `SER-0` measured on the scalar branch: a bigint
      // in the tree is a typed refusal in every context, never accepted bytes.
      name: "an out-of-type bigint is refused, not encoded",
      render: () => serializePnlState({ ...emptyPnlState(INSTANCE_STREAM), recordCount: 1n as never }),
    },
    {
      // The one scalar `JSON.stringify` has no text for: an own optional
      // identity field explicitly `undefined` is rendered as the word, exactly
      // as before `SER-1` — byte-identity, not redesign.
      name: "an explicit undefined optional keeps its measured rendering",
      render: () => serializePnlState(emptyPnlState({ ...INSTANCE_STREAM, runId: undefined })),
    },
  ];

  it("emits the same bytes in all six contexts, with toJSON run 0 times, and refuses a bigint typed", () => {
    const { clean, divergences } = sweepInheritedToJson(scenarios);
    expect(renderDivergences(divergences)).toEqual([]);
    expect(clean.get("serializePnlState")?.startsWith("ok:polymarket-bot/pnl-state/v3:{")).toBe(true);
    expect(clean.get("serializePnlState")).toContain(
      `"feesBySchedule":{"[\\"${USDC}\\",\\"\\"]":"0.07","[\\"${PUSD}\\",\\"fees-v1\\"]":"0.05","[\\"${PUSD}\\",\\"fees-v2\\"]":"0.02"}`,
    );
    expect(clean.get("serializeRealizedPnl")?.startsWith("ok:polymarket-bot/pnl-state/v3:realized:{")).toBe(true);
    expect(clean.get("serializePnlSnapshots")?.startsWith("ok:polymarket-bot/pnl-snapshot/v2:[{")).toBe(true);
    expect(clean.get("an out-of-type bigint is refused, not encoded")).toBe(
      "threw:value: a bigint has no JSON representation",
    );
    expect(clean.get("an explicit undefined optional keeps its measured rendering")).toContain(
      "\"runId\":undefined,",
    );
  });
});
