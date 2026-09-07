/**
 * REGRESSION: a settlement OBSERVATION's declared fields must be its OWN, and
 * the values a market settles on must come from the documents themselves
 * (`docs/contracts/schema-boundary.md` §3, the `packages/settlement` row —
 * probe N, HIGH; ADR-020 §1 class 1 and §3; SETL-1 review r1 claim 7).
 *
 * MEASURED AT BASE `c2c0733`, reproduce-first, end to end through
 * `evaluateSettlement`. Every row below failed there before it was closed:
 *
 * - **The 39-cell sweep.** Four observation variants, five (spec, observation)
 *   pairings, every key the schemas DECLARE, both pollution variants. All 36
 *   present-key cells adopted: delete the key, let `Object.prototype` supply it,
 *   and the settlement completed with the SAME verdict the honest reading
 *   produced. The remaining 3 (the optional window fields of an up/down reading
 *   on a `TERMINAL_SPOT`-settled spec) failed the other way — an inherited
 *   window REFUSED an honest reading.
 * - **The headline: a wrong VALUE on a payout surface.** A terminal-spot reading
 *   carrying no `strike` of its own settled `YES_WIN` against
 *   `comparison.right: "0"` under an inherited `strike`, with
 *   `payoutPerShare {yes:"1", no:"0"}` attached. An inherited `observedValue`
 *   moved the settled number to `"999999"`; an inherited `comparison` on the
 *   SPEC side flipped the same market to `NO_WIN`.
 * - **Both mismatch gates were answerable from the chain, from either side.** An
 *   `eth.usd` reading settled a `btc.usd` spec; a reading with no window settled
 *   a TWAP-settled up/down series.
 * - **The audit record could lie.** Each value is read twice on this path — once
 *   for the comparison, once for the record — so an accessor returning
 *   `"64000.25"` then `"1"` settled `YES_WIN` on the first read and recorded
 *   `comparison.left: "1"`. No prototype access is needed for this one.
 * - **A documented non-throwing function threw.** The compatibility matrix was
 *   an object literal, so one inherited `observationType` produced
 *   `TypeError: requirements.required is not iterable` out of
 *   `checkPayoffModelCompatibility`, and `isCompatiblePayoffModel("toString", …)`
 *   answered `true`.
 * - **D4.** The emitted evaluation and comparison had `Object.prototype` and
 *   were not frozen, so `evaluation.payoutPerShare` on a `PENDING` market read
 *   an inherited `{yes:"1", no:"1"}` — a redemption value for a market that
 *   determines none (ADR-009 §4).
 *
 * BOTH POLLUTION VARIANTS ARE PINNED, and on this path they are measured to
 * behave IDENTICALLY at base: no `zod` runs here, so there is no `strictObject`
 * accident to hide behind (contrast the spec door, where the enumerable variant
 * was refused by accident — REC-1 F1). The enumerable-copy materializer mutant
 * is killed by the enumerable half of the sweep.
 *
 * MUTANTS KILLED ON ARRIVAL (REC-1's lesson: a defence no test reaches is a
 * defence that can be reverted in one token). Each was applied alone to the tip
 * and the whole settlement suite run; the kill set is EXACT — the listed tests
 * fail and every other test stays green:
 *
 * | Mutant | Kills |
 * | --- | --- |
 * | enumerable-copy materializer (D1 → spread copy) | 2 |
 * | door-delete (no D1 read at all) | 2 |
 * | D1-identity, up/down branch (evaluator gets the caller's object) | 3 |
 * | D1-identity, the projection itself (`buildOwnObservation` → the tree) | 1 |
 * | presence-delete (the required-key loop) | 6 |
 * | unknown-key-delete (the strict-object restatement) | 1 |
 * | containment-delete (matrix lookup → `COMPATIBILITY[m][t]`) | 1 |
 * | `fieldIsPresent` own read → `view[field]` | 2 |
 * | model gate own read → `observation.model` | 1 |
 * | symbol gate own reads → dot reads | 2 |
 * | D4 revert, the evaluation record | 2 |
 * | D4 revert, the payout records | 2 |
 * | payout containment-delete (the `terminal` detail) | 1 |
 * | each of the SIX `UUID_V7_FORM` single-group case drifts | 1 each |
 *
 * EIGHT MUTANTS SURVIVE, and they are named rather than hidden (the SETL-2
 * review measured eight where this header originally said three; corrected
 * pre-merge with the reviewer's enumeration). Reverting `requireComparison`,
 * `selectPayoffModel`'s returned model, `checkTwapWindow`'s `windowSeconds`,
 * or `evaluateReferenceOpenUpDown`'s `ownField(spec, "observationType")` to a
 * dot read leaves this suite green — and so does handing the caller's object
 * to the TERMINAL-SPOT, TWAP or THRESHOLD evaluator, or making
 * `observationOwnIssues`' no-table branch return `[]`. All eight facts have
 * the same cause: those reads are SECOND-LINE. Every cell of the
 * compatibility matrix requires the spec field the second line would read,
 * every key those evaluators read is in the door's REQUIRED table (the
 * up/down evaluator's D1-identity mutant IS killed, 3 kills, precisely
 * because its three window fields are optional), the up/down
 * `observationType` read is refused earlier by `candidatePayoffModels`, and
 * the no-table branch only ever receives a `PAYOFF_MODEL_IDS`-validated
 * model. The first gate's own reads are the ones that carry the property,
 * and they are killed above. See "the first gate answers before the
 * second-line reads are reached", which pins that ordering rather than
 * assuming it.
 *
 * DEPLOYMENT READING, required whenever the §3 row is quoted: nothing on the
 * wire can write `Object.prototype`; every prototype class above needs code
 * already executing in the process. The accessor row is the exception — a
 * caller-supplied getter needs nothing at all — and the failure mode of the
 * whole file is a market settled at a price nobody observed.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  checkPayoffModelCompatibility,
  isCompatiblePayoffModel,
  observationTypesForPayoffModel,
  payoffModelRequirements,
  payoffModelsForObservationType,
} from "./models/compatibility.js";
import { evaluateSettlement, selectPayoffModel } from "./models/registry.js";
import {
  OBSERVATION_DECLARED_KEYS,
  OBSERVATION_REQUIRED_KEYS,
  buildOwnObservation,
  readOwnObservation,
} from "./observation-door.js";
import {
  ReferenceOpenUpDownObservationSchema,
  TerminalSpotObservationSchema,
  ThresholdByDateObservationSchema,
  TwapObservationSchema,
} from "./observation.js";
import { payoutPerShare } from "./payout.js";
import { parseSettlementSpec, type SettlementSpec } from "./spec.js";
import {
  referenceOpenUpDownObservationSample,
  referenceOpenUpDownSpecSample,
  terminalSpotObservationSample,
  terminalSpotSpecSample,
  thresholdByDateObservationSample,
  thresholdByDateSpecSample,
  twapObservationSample,
  twapSpecSample,
  verifiedSpec,
} from "./testing/index.js";
import { OBSERVATION_TYPES, PAYOFF_MODEL_IDS } from "./vocabulary.js";

// ---------------------------------------------------------------------------
// Harness. Both pollution variants, and nothing is left on `Object.prototype`.
// ---------------------------------------------------------------------------

type Entries = readonly (readonly [string, unknown])[];

function polluted<T>(entries: Entries, enumerable: boolean, body: () => T): T {
  for (const [key, value] of entries) {
    Object.defineProperty(Object.prototype, key, {
      value,
      enumerable,
      configurable: true,
      writable: true,
    });
  }
  try {
    return body();
  } finally {
    for (const [key] of entries) Reflect.deleteProperty(Object.prototype, key);
  }
}

/** Runs `body` under BOTH variants, labelling each. */
function bothVariants<T>(entries: Entries, body: () => T): readonly (readonly [string, T])[] {
  return [
    ["non-enumerable", polluted(entries, false, body)],
    ["enumerable", polluted(entries, true, body)],
  ];
}

type Row = Record<string, unknown>;

function record(observation: unknown): Row {
  return { ...(observation as Row) };
}

function without(observation: unknown, key: string): Row {
  const copy = record(observation);
  delete copy[key];
  return copy;
}

function codes(result: ReturnType<typeof evaluateSettlement>): readonly string[] {
  return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

const twapUpDownSpec: SettlementSpec = parseSettlementSpec({
  ...referenceOpenUpDownSpecSample(),
  observationType: "TWAP",
  windowSeconds: 60,
  windowStartRule: "Sixty seconds before the market close instant.",
  windowEndRule: "The market close instant, inclusive.",
});

const windowedUpDownObservation = {
  ...referenceOpenUpDownObservationSample(),
  windowSeconds: 60,
  windowStartAt: "2026-08-28T11:59:00Z",
  windowEndAt: "2026-08-28T12:00:00Z",
};

/** The five (spec, reading) pairings the sweep walks, with the schema's own key list. */
const CELLS: readonly (readonly [string, SettlementSpec, Row, readonly string[]])[] = [
  [
    "TerminalSpot",
    parseSettlementSpec(terminalSpotSpecSample()),
    record(terminalSpotObservationSample()),
    Object.keys(TerminalSpotObservationSchema.shape),
  ],
  [
    "Twap",
    parseSettlementSpec(twapSpecSample()),
    record(twapObservationSample()),
    Object.keys(TwapObservationSchema.shape),
  ],
  [
    "ReferenceOpenUpDown/TERMINAL_SPOT spec",
    parseSettlementSpec(referenceOpenUpDownSpecSample()),
    record(referenceOpenUpDownObservationSample()),
    Object.keys(ReferenceOpenUpDownObservationSchema.shape),
  ],
  [
    "ReferenceOpenUpDown/TWAP spec",
    twapUpDownSpec,
    record(windowedUpDownObservation),
    Object.keys(ReferenceOpenUpDownObservationSchema.shape),
  ],
  [
    "ThresholdByDate",
    parseSettlementSpec(thresholdByDateSpecSample()),
    record(thresholdByDateObservationSample()),
    Object.keys(ThresholdByDateObservationSchema.shape),
  ],
];

describe("the settlement observation door: the reading states what it settles on", () => {
  // -------------------------------------------------------------------------
  // The census, derived from the schemas rather than trusted.
  // -------------------------------------------------------------------------

  it("the census the sweep rests on: 4 variants, 30 declared keys, 3 optional", () => {
    const shapes = [
      ["TerminalSpotBinaryModel", TerminalSpotObservationSchema.shape],
      ["TwapBinaryModel", TwapObservationSchema.shape],
      ["ReferenceOpenUpDownModel", ReferenceOpenUpDownObservationSchema.shape],
      ["ThresholdByDateModel", ThresholdByDateObservationSchema.shape],
    ] as const;

    let declaredTotal = 0;
    let optionalTotal = 0;
    for (const [model, shape] of shapes) {
      const declared = Object.keys(shape);
      declaredTotal += declared.length;
      // The door's tables are the SCHEMA's, in schema order — not a hand copy
      // that can drift. A field added to an observation without a row in
      // `observation-door.ts` fails here rather than riding through the door.
      expect(OBSERVATION_DECLARED_KEYS.get(model), model).toEqual(declared);
      const required = declared.filter(
        (key) => shape[key as keyof typeof shape].safeParse(undefined).success === false,
      );
      optionalTotal += declared.length - required.length;
      expect(OBSERVATION_REQUIRED_KEYS.get(model), model).toEqual(required);
    }
    expect(declaredTotal).toBe(30);
    expect(optionalTotal).toBe(3);
    // …and the sweep really walks 39 cells (36 present + 3 absent-optional).
    const present = CELLS.reduce(
      (total, [, , sample, keys]) => total + keys.filter((key) => Object.hasOwn(sample, key)).length,
      0,
    );
    const absent = CELLS.reduce(
      (total, [, , sample, keys]) => total + keys.filter((key) => !Object.hasOwn(sample, key)).length,
      0,
    );
    expect([present, absent]).toEqual([36, 3]);
  });

  // -------------------------------------------------------------------------
  // The sweep itself: the whole measured class, both variants.
  // -------------------------------------------------------------------------

  it("EVERY declared field is refused when only the prototype supplies it (both variants)", () => {
    const adopted: string[] = [];
    for (const [cell, spec, sample, keys] of CELLS) {
      for (const key of keys) {
        if (!Object.hasOwn(sample, key)) continue;
        const holed = without(sample, key);
        for (const [variant, result] of bothVariants([[key, sample[key]]], () =>
          evaluateSettlement(spec, holed as never),
        )) {
          if (result.ok) {
            adopted.push(`${cell}.${key} (${variant}): settled ${result.value.outcomeState}`);
          }
        }
      }
    }
    // At base all 36 cells × 2 variants settled here.
    expect(adopted).toEqual([]);
  });

  it("…and the refusal says which document failed to state the field", () => {
    const spec = parseSettlementSpec(terminalSpotSpecSample());
    const sample = record(terminalSpotObservationSample());
    // `model` and `referenceSymbol` are the two gates that already had a code of
    // their own; every other declared field is the door's own refusal.
    const expected: Readonly<Record<string, string>> = {
      model: "SETTLEMENT_OBSERVATION_MODEL_MISMATCH",
      referenceSymbol: "SETTLEMENT_OBSERVATION_SYMBOL_MISMATCH",
      observedValue: "SETTLEMENT_OBSERVATION_INVALID",
      observedAt: "SETTLEMENT_OBSERVATION_INVALID",
      strike: "SETTLEMENT_OBSERVATION_INVALID",
    };
    for (const [key, code] of Object.entries(expected)) {
      const holed = without(sample, key);
      for (const [variant, result] of bothVariants([[key, sample[key]]], () =>
        evaluateSettlement(spec, holed as never),
      )) {
        expect(codes(result), `${key} (${variant})`).toEqual([code]);
      }
    }
    const detail = evaluateSettlement(spec, without(sample, "strike") as never);
    expect(detail.ok).toBe(false);
    if (detail.ok) throw new Error("unreachable");
    expect(detail.refusals[0]?.details["issues"]).toEqual([
      "strike: the observation does not state it, and no other document may state it for it",
    ]);
  });

  it("a field no observation variant declares cannot ride along either", () => {
    const spec = parseSettlementSpec(terminalSpotSpecSample());
    const withExtra = { ...terminalSpotObservationSample(), settledBy: "somebody else" };
    expect(codes(evaluateSettlement(spec, withExtra as never))).toEqual([
      "SETTLEMENT_OBSERVATION_INVALID",
    ]);
    // …including a field that belongs to a DIFFERENT variant of the union.
    const wrongVariant = { ...terminalSpotObservationSample(), twapValue: "64000.25" };
    expect(codes(evaluateSettlement(spec, wrongVariant as never))).toEqual([
      "SETTLEMENT_OBSERVATION_INVALID",
    ]);
  });

  // -------------------------------------------------------------------------
  // The headline rows, spelled out.
  // -------------------------------------------------------------------------

  describe("the values a market settles on come from the documents", () => {
    const terminalSpot = parseSettlementSpec(terminalSpotSpecSample());

    it("an inherited `strike` cannot become the strike a market settles against", () => {
      const noStrike = without(terminalSpotObservationSample(), "strike");
      for (const [variant, result] of bothVariants([["strike", "0"]], () =>
        evaluateSettlement(terminalSpot, noStrike as never),
      )) {
        // At base: YES_WIN, comparison.right "0", payoutPerShare {yes:"1"}.
        expect(codes(result), variant).toEqual(["SETTLEMENT_OBSERVATION_INVALID"]);
      }
      // The honest reading is untouched: the strike it states is the one used.
      const honest = evaluateSettlement(terminalSpot, terminalSpotObservationSample());
      expect(honest.ok && honest.value.comparison.right).toBe("64000");
    });

    it("an inherited `observedValue` cannot become the settled number", () => {
      const noValue = without(terminalSpotObservationSample(), "observedValue");
      for (const [variant, result] of bothVariants([["observedValue", "999999"]], () =>
        evaluateSettlement(terminalSpot, noValue as never),
      )) {
        expect(codes(result), variant).toEqual(["SETTLEMENT_OBSERVATION_INVALID"]);
      }
    });

    it("the symbol gate cannot be satisfied from the chain, from either side", () => {
      // The reading's side: an `eth.usd` observation whose own key is deleted.
      const ethReading = without(
        { ...terminalSpotObservationSample(), referenceSymbol: "eth.usd" },
        "referenceSymbol",
      );
      for (const [variant, result] of bothVariants([["referenceSymbol", "btc.usd"]], () =>
        evaluateSettlement(terminalSpot, ethReading as never),
      )) {
        expect(codes(result), variant).toEqual(["SETTLEMENT_OBSERVATION_SYMBOL_MISMATCH"]);
      }
      // The SPEC's side: a caller-built spec that states no symbol of its own.
      const specWithoutSymbol = without(terminalSpotSpecSample(), "referenceSymbol");
      for (const [variant, result] of bothVariants([["referenceSymbol", "eth.usd"]], () =>
        evaluateSettlement(specWithoutSymbol as never, {
          ...terminalSpotObservationSample(),
          referenceSymbol: "eth.usd",
        } as never),
      )) {
        expect(codes(result), variant).toEqual(["SETTLEMENT_OBSERVATION_SYMBOL_MISMATCH"]);
      }
    });

    it("an inherited window cannot settle a TWAP-settled series on a reading that has none", () => {
      const window: Entries = [
        ["windowSeconds", 60],
        ["windowStartAt", "2026-08-28T11:59:00Z"],
        ["windowEndAt", "2026-08-28T12:00:00Z"],
      ];
      for (const [variant, result] of bothVariants(window, () =>
        evaluateSettlement(twapUpDownSpec, referenceOpenUpDownObservationSample()),
      )) {
        expect(codes(result), variant).toEqual(["SETTLEMENT_OBSERVATION_WINDOW_MISMATCH"]);
      }
    });

    it("an inherited `comparison` cannot decide the direction of a settlement", () => {
      const specWithoutComparison = without(terminalSpotSpecSample(), "comparison");
      for (const [variant, result] of bothVariants([["comparison", "LT"]], () =>
        evaluateSettlement(specWithoutComparison as never, terminalSpotObservationSample()),
      )) {
        // At base this settled NO_WIN under the inherited `LT`.
        expect(codes(result), variant).toContain("SETTLEMENT_SPEC_FIELD_REQUIRED");
        expect(result.ok, variant).toBe(false);
      }
    });

    it("an inherited `payoffModel` cannot select a model for a spec that declares none", () => {
      const specWithoutModel = without(terminalSpotSpecSample(), "payoffModel");
      for (const [variant, selected] of bothVariants(
        [["payoffModel", "TerminalSpotBinaryModel"]],
        () => selectPayoffModel(specWithoutModel as never),
      )) {
        // At base: `{ok:true, value:"TerminalSpotBinaryModel"}`.
        expect(selected.ok, variant).toBe(false);
      }
    });

    it("an inherited spec field cannot satisfy a payoff model's requirements", () => {
      const inherited: Entries = [
        ["payoffModel", "TwapBinaryModel"],
        ["comparison", "GT"],
        ["strikeSource", "a strike source nobody reviewed"],
        ["windowSeconds", 30],
        ["windowStartRule", "a window rule nobody reviewed"],
        ["windowEndRule", "a window rule nobody reviewed"],
      ];
      for (const [variant, refusals] of bothVariants(inherited, () =>
        checkPayoffModelCompatibility({ observationType: "TWAP" } as never),
      )) {
        // At base this list was EMPTY: a spec declaring nothing was judged
        // fully compatible with the model the prototype named.
        expect(refusals.map((refusal) => refusal.code), variant).toEqual([
          "SETTLEMENT_SPEC_FIELD_REQUIRED",
        ]);
        expect(refusals[0]?.details["field"], variant).toBe("payoffModel");
      }

      // …and the REQUIRED-FIELD LOOP itself, reached only by a view that states
      // its own model: without this row the `ownField` read inside
      // `fieldIsPresent` is unpinned, because the row above never gets past the
      // "declares no payoff model" refusal (SETL-1's B3 lesson — a defence that
      // no test reaches is a defence that can be reverted in one token).
      for (const [variant, refusals] of bothVariants(inherited.slice(1), () =>
        checkPayoffModelCompatibility({
          observationType: "TWAP",
          payoffModel: "TwapBinaryModel",
        } as never),
      )) {
        expect(refusals.map((refusal) => refusal.details["field"]), variant).toEqual([
          "comparison",
          "strikeSource",
          "windowSeconds",
          "windowStartRule",
          "windowEndRule",
        ]);
        for (const refusal of refusals) {
          expect(refusal.code, variant).toBe("SETTLEMENT_SPEC_FIELD_REQUIRED");
        }
      }
    });

    it("an inherited spec field cannot make a permitted spec look ambiguous either", () => {
      // The FORBIDDEN half, and the other direction of the same class: a spec
      // that legitimately states no `referenceOpenSource` must not be refused
      // because the prototype states one for it.
      const view = {
        observationType: "TWAP",
        payoffModel: "TwapBinaryModel",
        comparison: "GT",
        strikeSource: "The strike stated in the market rules text.",
        windowSeconds: 30,
        windowStartRule: "Thirty seconds before the market close instant.",
        windowEndRule: "The market close instant, inclusive.",
      } as const;
      expect(checkPayoffModelCompatibility(view)).toEqual([]);
      for (const [variant, refusals] of bothVariants(
        [["referenceOpenSource", "a source nobody reviewed"]],
        () => checkPayoffModelCompatibility(view),
      )) {
        expect(refusals.map((refusal) => refusal.code), variant).toEqual([]);
      }
    });
  });

  /**
   * WHICH GATE SPEAKS, pinned rather than assumed.
   *
   * Three spec reads on this path are SECOND-LINE: `requireComparison`,
   * `selectPayoffModel`'s returned model, and `checkTwapWindow`'s
   * `windowSeconds`. Each is an own read, and each is unreachable with the field
   * missing WHILE the first gate — the compatibility check's own reads — holds,
   * because every cell of the matrix requires the field the second line would
   * read. That is why reverting one of them alone leaves this suite green, and
   * the honest way to state it is to pin the ORDER: the mutants that matter are
   * the FIRST gate's (killed above), and the fact that it answers first is
   * measured here rather than argued.
   */
  it("the first gate answers before the second-line reads are reached", () => {
    const cases = [
      ["comparison", without(terminalSpotSpecSample(), "comparison"), "comparison"],
      ["payoffModel", without(terminalSpotSpecSample(), "payoffModel"), "payoffModel"],
      ["windowSeconds", without(twapSpecSample(), "windowSeconds"), "windowSeconds"],
    ] as const;
    for (const [label, spec, field] of cases) {
      const result = evaluateSettlement(spec as never, terminalSpotObservationSample());
      expect(result.ok, label).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(
        result.refusals.map((refusal) => refusal.details["field"]),
        label,
      ).toContain(field);
      expect(codes(result), label).toContain("SETTLEMENT_SPEC_FIELD_REQUIRED");
    }
  });

  // -------------------------------------------------------------------------
  // The other direction: availability. An inherited field must not REFUSE an
  // honest reading either (the three optional cells failed exactly that way).
  // -------------------------------------------------------------------------

  it("an inherited optional window cannot refuse an honest spot reading", () => {
    const upDown = parseSettlementSpec(referenceOpenUpDownSpecSample());
    for (const key of ["windowSeconds", "windowStartAt", "windowEndAt"] as const) {
      const value = key === "windowSeconds" ? 30 : "2026-08-28T11:59:30Z";
      for (const [variant, result] of bothVariants([[key, value]], () =>
        evaluateSettlement(upDown, referenceOpenUpDownObservationSample()),
      )) {
        // At base: SETTLEMENT_OBSERVATION_WINDOW_MISMATCH — the same class,
        // refusing a reading the contract accepts.
        expect(result.ok, `${key} (${variant})`).toBe(true);
        expect(result.ok && result.value.outcomeState).toBe("YES_WIN");
      }
    }
  });

  it("an honest settlement is byte-identical under either pollution variant", () => {
    const noise: Entries = [
      ["strike", "0"],
      ["observedValue", "999999"],
      ["model", "TwapBinaryModel"],
      ["referenceSymbol", "eth.usd"],
      ["comparison", "LT"],
      ["payoffModel", "TwapBinaryModel"],
      ["windowSeconds", 30],
      ["verification", { status: "VERIFIED", verifiedBy: "x", verifiedAt: "2026-08-28T00:00:00Z" }],
      ["skipChecks", true],
    ];
    const clean = JSON.stringify(
      evaluateSettlement(
        parseSettlementSpec(verifiedSpec(terminalSpotSpecSample())),
        terminalSpotObservationSample(),
      ),
    );
    for (const [variant, rendered] of bothVariants(noise, () =>
      JSON.stringify(
        evaluateSettlement(
          parseSettlementSpec(verifiedSpec(terminalSpotSpecSample())),
          terminalSpotObservationSample(),
        ),
      ),
    )) {
      expect(rendered, variant).toBe(clean);
    }
  });

  // -------------------------------------------------------------------------
  // D2 is VACUOUS here, and that is a measured claim rather than a hope.
  // -------------------------------------------------------------------------

  it("no library check decides anything on this path (`skipChecks` changes nothing)", () => {
    const spec = parseSettlementSpec(terminalSpotSpecSample());
    const honest = JSON.stringify(evaluateSettlement(spec, terminalSpotObservationSample()));
    const noStrike = without(terminalSpotObservationSample(), "strike");
    for (const entries of [
      [["skipChecks", true]],
      [
        ["optin", "optional"],
        ["optout", "optional"],
      ],
      [["when", () => false]],
    ] as const) {
      for (const [variant, rendered] of bothVariants(entries, () =>
        JSON.stringify(evaluateSettlement(spec, terminalSpotObservationSample())),
      )) {
        expect(rendered, `honest ${variant}`).toBe(honest);
      }
      for (const [variant, result] of bothVariants([...entries, ["strike", "0"]], () =>
        evaluateSettlement(spec, noStrike as never),
      )) {
        // The door's presence rule is not a `zod` check and cannot be switched
        // off: at base this settled YES_WIN against the inherited "0" WITH
        // `skipChecks` inherited, exactly as it did without it.
        expect(codes(result), `hole ${variant}`).toEqual(["SETTLEMENT_OBSERVATION_INVALID"]);
      }
    }
  });

  // -------------------------------------------------------------------------
  // D1: what the materializer refuses, and that it materializes at all.
  // -------------------------------------------------------------------------

  describe("D1: the reading is read as plain own data, or refused", () => {
    const spec = parseSettlementSpec(terminalSpotSpecSample());

    it("an accessor is refused and NEVER invoked, so the record cannot lie", () => {
      let reads = 0;
      const twoFaced = record(terminalSpotObservationSample());
      Object.defineProperty(twoFaced, "observedValue", {
        get: () => {
          reads += 1;
          return reads === 1 ? "64000.25" : "1";
        },
        enumerable: true,
        configurable: true,
      });
      const result = evaluateSettlement(spec, twoFaced as never);
      // At base: settled YES_WIN on the first read and recorded
      // `comparison.left: "1"` from the second — the audit disagreed with the
      // number that decided the payout, with no prototype access at all.
      expect(codes(result)).toEqual(["SETTLEMENT_OBSERVATION_INVALID"]);
      expect(reads).toBe(0);
    });

    it("a value a measured reading cannot carry is refused rather than settled on", () => {
      const sample = record(terminalSpotObservationSample());
      const foreignPrototype = Object.create({ strike: "0" }) as Row;
      for (const key of Object.keys(sample)) foreignPrototype[key] = sample[key];

      const cyclic = record(terminalSpotObservationSample());
      cyclic["self"] = cyclic;

      for (const [label, value] of [
        ["a foreign prototype", foreignPrototype],
        ["a symbol-keyed field", { ...sample, [Symbol("x")]: 1 }],
        ["a function field", { ...sample, strike: (): string => "0" }],
        ["a cycle", cyclic],
        ["not a record at all", 42],
        ["null", null],
        ["an array", [sample]],
      ] as const) {
        const result = evaluateSettlement(spec, value as never);
        expect(codes(result), label).toEqual(["SETTLEMENT_OBSERVATION_INVALID"]);
      }

      // An own `__proto__` field: the one name a copy cannot carry faithfully.
      const protoKeyed = JSON.parse(
        `{"__proto__":{"polluted":true},${JSON.stringify(terminalSpotObservationSample()).slice(1)}`,
      ) as unknown;
      expect(codes(evaluateSettlement(spec, protoKeyed as never))).toEqual([
        "SETTLEMENT_OBSERVATION_INVALID",
      ]);
      expect(({} as Row)["polluted"]).toBeUndefined();
    });

    it("D1 builds a NEW prototype-free tree rather than handing the input over", () => {
      const sample = terminalSpotObservationSample();
      const read = readOwnObservation(sample);
      expect(read.ok).toBe(true);
      if (!read.ok) throw new Error("unreachable");
      expect(read.value).not.toBe(sample);
      expect(Object.getPrototypeOf(read.value)).toBeNull();
      expect({ ...read.value }).toEqual({ ...sample });
    });

    it("D3: the evaluators settle on the projection, not on the caller's object", () => {
      // The projection carries the DECLARED keys only, frozen, prototype-free —
      // so a dot read inside a model evaluator is an own read by construction,
      // and a caller cannot mutate the reading after it was judged.
      const tree = readOwnObservation(twapObservationSample());
      expect(tree.ok).toBe(true);
      if (!tree.ok) throw new Error("unreachable");
      const projected = buildOwnObservation<Row>("TwapBinaryModel", tree.value);
      expect(Object.getPrototypeOf(projected)).toBeNull();
      expect(Object.isFrozen(projected)).toBe(true);
      expect(Object.keys(projected)).toEqual(OBSERVATION_DECLARED_KEYS.get("TwapBinaryModel"));
      expect(projected).not.toBe(tree.value);

      // An optional key the reading does not state stays ABSENT in the
      // projection rather than becoming `undefined` — "absent" and "present but
      // undefined" must not diverge for the window rules that branch on it.
      const spot = readOwnObservation(referenceOpenUpDownObservationSample());
      if (!spot.ok) throw new Error("unreachable");
      const projectedSpot = buildOwnObservation<Row>("ReferenceOpenUpDownModel", spot.value);
      expect(Object.hasOwn(projectedSpot, "windowSeconds")).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // The compatibility matrix: a table that decides payouts is not a plain
  // object literal any more.
  // -------------------------------------------------------------------------

  describe("the compatibility matrix answers about itself only", () => {
    it("a non-declared observation type is refused, not answered by `Object.prototype`", () => {
      // At base: `true`, a FUNCTION, and a thrown TypeError respectively.
      for (const key of ["toString", "constructor", "valueOf", "__proto__", "hasOwnProperty"]) {
        expect(isCompatiblePayoffModel(key as never, "TerminalSpotBinaryModel"), key).toBe(false);
        expect(payoffModelRequirements(key as never, "TerminalSpotBinaryModel"), key).toBeUndefined();
        expect(payoffModelsForObservationType(key as never), key).toEqual([]);
        expect(observationTypesForPayoffModel(key as never), key).toEqual([]);
        expect(
          checkPayoffModelCompatibility({ observationType: key, payoffModel: "TerminalSpotBinaryModel" } as never).map(
            (refusal) => refusal.code,
          ),
          key,
        ).toEqual(["SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL"]);
      }
    });

    it("…including through one inherited `observationType`, with no cast at all", () => {
      for (const [variant, refusals] of bothVariants([["observationType", "toString"]], () =>
        checkPayoffModelCompatibility({ payoffModel: "TerminalSpotBinaryModel" } as never).map(
          (refusal) => refusal.code,
        ),
      )) {
        // At base: `TypeError: requirements.required is not iterable`, escaping
        // a function this package documents as returning a list.
        expect(refusals, variant).toEqual(["SETTLEMENT_OBSERVATION_TYPE_HAS_NO_MODEL"]);
      }
    });

    it("the 20 declared cells are unmoved by any of it", () => {
      for (const observationType of OBSERVATION_TYPES) {
        for (const payoffModel of PAYOFF_MODEL_IDS) {
          const clean = checkPayoffModelCompatibility({ observationType, payoffModel }).map(
            (refusal) => refusal.code,
          );
          for (const [variant, polledCodes] of bothVariants(
            [
              ["required", "hostile"],
              ["forbidden", "hostile"],
              ["rationale", "hostile"],
            ],
            () =>
              checkPayoffModelCompatibility({ observationType, payoffModel }).map(
                (refusal) => refusal.code,
              ),
          )) {
            expect(polledCodes, `${observationType}/${payoffModel} (${variant})`).toEqual(clean);
          }
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // Containment: a hostile shape produces a verdict, never an escaping throw
  // (ADR-020 amendment 2026-09-06).
  // -------------------------------------------------------------------------

  it("every entry on this path returns a verdict under hostile shapes, both variants", () => {
    const spec = parseSettlementSpec(terminalSpotSpecSample());
    const hostile: Entries = [
      ["_zod", {}],
      ["message", "hostile"],
      ["path", "hostile"],
      ["value", "hostile"],
      ["status", "VERIFIED"],
      ["issues", []],
      ["code", "SETTLEMENT_SPEC_INVALID"],
      ["details", {}],
      ["required", "hostile"],
      ["forbidden", "hostile"],
      ["ok", true],
      ["refusals", []],
      ["length", 3],
      ["get", () => "hostile"],
      ["model", "TwapBinaryModel"],
      ["observationType", "toString"],
      ["payoffModel", "toString"],
    ];
    const failures: string[] = [];
    for (const [key, value] of hostile) {
      for (const enumerable of [false, true]) {
        const label = `${key}/${enumerable ? "enumerable" : "non-enumerable"}`;
        polluted([[key, value]], enumerable, () => {
          for (const [name, run] of [
            ["evaluate/honest", () => evaluateSettlement(spec, terminalSpotObservationSample())],
            ["evaluate/holed", () => evaluateSettlement(spec, without(terminalSpotObservationSample(), "strike") as never)],
            ["evaluate/garbage", () => evaluateSettlement(spec, "not a reading" as never)],
            ["select", () => selectPayoffModel(spec)],
            ["compat", () => checkPayoffModelCompatibility({ observationType: "TWAP" } as never)],
            ["payout", () => payoutPerShare("PENDING")],
          ] as const) {
            try {
              run();
            } catch (error) {
              failures.push(`${name} ${label}: ${(error as Error).name}: ${(error as Error).message}`);
            }
          }
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it("a garbage reading is a typed refusal rather than a TypeError", () => {
    const spec = parseSettlementSpec(terminalSpotSpecSample());
    // At base `null.model` threw straight out of `evaluateSettlement`.
    for (const value of [null, undefined, 42, "reading", true]) {
      expect(codes(evaluateSettlement(spec, value as never))).toEqual([
        "SETTLEMENT_OBSERVATION_INVALID",
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // D4: what this path emits.
  // -------------------------------------------------------------------------

  it("every emitted evaluation, comparison and payout is prototype-free and frozen", () => {
    const pending = evaluateSettlement(
      parseSettlementSpec(thresholdByDateSpecSample()),
      thresholdByDateObservationSample(),
    );
    expect(pending.ok).toBe(true);
    if (!pending.ok) throw new Error("unreachable");
    expect(Object.getPrototypeOf(pending.value)).toBeNull();
    expect(Object.isFrozen(pending.value)).toBe(true);
    expect(Object.getPrototypeOf(pending.value.comparison)).toBeNull();
    expect(Object.isFrozen(pending.value.comparison)).toBe(true);

    // A PENDING market determines no payout, and no prototype may supply one.
    expect(Object.hasOwn(pending.value, "payoutPerShare")).toBe(false);
    for (const [variant, adopted] of bothVariants(
      [["payoutPerShare", { yes: "1", no: "1" }]],
      () => pending.value.payoutPerShare,
    )) {
      // At base: `{yes:"1", no:"1"}` — a redemption value for a market that
      // determines none (ADR-009 §4).
      expect(adopted, variant).toBeUndefined();
    }

    const settled = evaluateSettlement(
      parseSettlementSpec(terminalSpotSpecSample()),
      terminalSpotObservationSample(),
    );
    expect(settled.ok && Object.getPrototypeOf(settled.value.payoutPerShare)).toBeNull();
    expect(settled.ok && Object.isFrozen(settled.value.payoutPerShare)).toBe(true);
    for (const outcome of ["YES_WIN", "NO_WIN", "SPLIT_50_50"] as const) {
      const payout = payoutPerShare(outcome);
      expect(payout.ok && Object.getPrototypeOf(payout.value), outcome).toBeNull();
      expect(payout.ok && Object.isFrozen(payout.value), outcome).toBe(true);
    }
    // …and a field the emitted record does not carry stays absent.
    for (const [variant, invented] of bothVariants([["nothingCarriesThis", "invented"]], () =>
      Object.hasOwn(pending.value, "nothingCarriesThis"),
    )) {
      expect(invented, variant).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // The honest-input digests. Both serializations, at true base and at tip.
  // -------------------------------------------------------------------------

  it("honest verdicts are byte-identical to the base's, in both serializations", () => {
    const rows = digestRows();
    expect(rows.value).toHaveLength(68);
    // MEASURED AT TRUE BASE `c2c0733` and unchanged at tip: the VALUE of every
    // honest verdict on this path — 31 evaluations, 7 payouts, 25 compatibility
    // rows, 5 selections — is what it always was. A door that quietly moved a
    // settlement, a payout or a refusal message fails here.
    expect(sha256(rows.value)).toBe(
      "6bd0ec8b908d5ecd466bf6c21bb3a9040f15901039ff653554a3f26c3274f218",
    );
    // The STRICT serialization records each emitted record's prototype, its
    // frozen flag and every property descriptor. It DIFFERS from the base's
    // `a4752babbec56e3baf91a5734c4dcbcd02baeb86e0f5e9cad472443fa91a5682`, and it
    // is meant to: D4 is exactly a change of those tags. The difference is
    // confined to the 17 rows that EMIT a record (14 settled evaluations + 3
    // payouts): `proto=Object,frozen=false` → `proto=null,frozen=true` and
    // `ewcv` → `e--v`. Normalising those two tags makes the two files equal,
    // row for row, which is how "D4 moved nothing but the tags" was checked.
    expect(sha256(rows.strict)).toBe(
      "d7bf77074c354ead16291b00f14c31e7a48ef8ce36be499ddaac1fe628bf81a0",
    );
  });
});

// ---------------------------------------------------------------------------
// The digest corpus. Deterministic, order-fixed, and identical to the one run
// at the true base — that is what makes the equality above evidence.
// ---------------------------------------------------------------------------

const terminalSpot = parseSettlementSpec(terminalSpotSpecSample());
const terminalSpotVerified = parseSettlementSpec(verifiedSpec(terminalSpotSpecSample()));
const terminalSpotGt = parseSettlementSpec({ ...terminalSpotSpecSample(), comparison: "GT" });
const twap = parseSettlementSpec(twapSpecSample());
const upDown = parseSettlementSpec(referenceOpenUpDownSpecSample());
const twapUpDown = twapUpDownSpec;
const thresholdByDate = parseSettlementSpec(thresholdByDateSpecSample());
const thresholdDownward = parseSettlementSpec({ ...thresholdByDateSpecSample(), comparison: "LTE" });
const modelless = parseSettlementSpec({
  ...terminalSpotSpecSample(),
  observationType: "MANUAL_ORACLE",
  comparison: undefined,
  strikeSource: undefined,
  payoffModel: undefined,
});

const EVALUATION_ROWS: readonly (readonly [string, SettlementSpec, unknown])[] = [
  ["terminal-spot/honest", terminalSpot, terminalSpotObservationSample()],
  ["terminal-spot/verified", terminalSpotVerified, terminalSpotObservationSample()],
  ["terminal-spot/below", terminalSpot, { ...terminalSpotObservationSample(), observedValue: "63999.99" }],
  ["terminal-spot/at-strike-gte", terminalSpot, { ...terminalSpotObservationSample(), observedValue: "64000" }],
  ["terminal-spot/at-strike-gt", terminalSpotGt, { ...terminalSpotObservationSample(), observedValue: "64000" }],
  ["terminal-spot/symbol", terminalSpot, { ...terminalSpotObservationSample(), referenceSymbol: "eth.usd" }],
  ["terminal-spot/model", twap, terminalSpotObservationSample()],
  ["twap/honest", twap, twapObservationSample()],
  ["twap/window-tag", twap, { ...twapObservationSample(), windowSeconds: 60 }],
  ["twap/inverted", twap, { ...twapObservationSample(), windowStartAt: "2026-08-28T12:00:00Z", windowEndAt: "2026-08-28T11:59:30Z" }],
  ["twap/unparseable", twap, { ...twapObservationSample(), windowEndAt: "not-a-timestamp" }],
  ["twap/span", twap, { ...twapObservationSample(), windowStartAt: "2026-08-28T11:00:00Z" }],
  ["twap/offset", twap, { ...twapObservationSample(), windowStartAt: "2026-08-28T13:59:30+02:00" }],
  ["updown/honest", upDown, referenceOpenUpDownObservationSample()],
  ["updown/flat", upDown, { ...referenceOpenUpDownObservationSample(), observedValue: "64000" }],
  ["updown/not-after-open", upDown, { ...referenceOpenUpDownObservationSample(), observedAt: "2026-08-28T11:45:00Z" }],
  ["updown/unexpected-window", upDown, { ...referenceOpenUpDownObservationSample(), windowSeconds: 30, windowStartAt: "2026-08-28T11:59:30Z", windowEndAt: "2026-08-28T12:00:00Z" }],
  ["updown-twap/honest", twapUpDown, { ...referenceOpenUpDownObservationSample(), windowSeconds: 60, windowStartAt: "2026-08-28T11:59:00Z", windowEndAt: "2026-08-28T12:00:00Z" }],
  ["updown-twap/no-window", twapUpDown, referenceOpenUpDownObservationSample()],
  ["updown-twap/wrong-window", twapUpDown, { ...referenceOpenUpDownObservationSample(), windowSeconds: 30, windowStartAt: "2026-08-28T11:59:30Z", windowEndAt: "2026-08-28T12:00:00Z" }],
  ["updown-twap/unparseable", twapUpDown, { ...referenceOpenUpDownObservationSample(), windowSeconds: 60, windowStartAt: "not-a-timestamp", windowEndAt: "2026-08-28T12:00:00Z" }],
  ["threshold/pending", thresholdByDate, thresholdByDateObservationSample()],
  ["threshold/met", thresholdByDate, { ...thresholdByDateObservationSample(), extremeValue: "150000" }],
  ["threshold/expired", thresholdByDate, { ...thresholdByDateObservationSample(), asOf: "2027-01-01T00:00:00Z" }],
  ["threshold/wrong-extreme", thresholdByDate, { ...thresholdByDateObservationSample(), extremeKind: "MIN" }],
  ["threshold/downward", thresholdDownward, { ...thresholdByDateObservationSample(), threshold: "20000", extremeKind: "MIN", extremeValue: "19000" }],
  ["threshold/outside-period", thresholdByDate, { ...thresholdByDateObservationSample(), extremeObservedAt: "2026-07-01T00:00:00Z" }],
  ["threshold/future-extreme", thresholdByDate, { ...thresholdByDateObservationSample(), extremeObservedAt: "2026-09-01T00:00:00Z" }],
  ["threshold/inverted-period", thresholdByDate, { ...thresholdByDateObservationSample(), periodStartAt: "2027-01-01T00:00:00Z" }],
  ["threshold/unparseable-asof", thresholdByDate, { ...thresholdByDateObservationSample(), asOf: "not-a-timestamp" }],
  ["modelless", modelless, terminalSpotObservationSample()],
];

function protoTag(value: unknown): string {
  if (typeof value !== "object" || value === null) return "-";
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === null) return "null";
  if (proto === Object.prototype) return "Object";
  if (proto === Array.prototype) return "Array";
  return "other";
}

/** Value + shape: prototypes, frozen flags and every property descriptor. */
function strictShape(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined";
  const parts: string[] = [`{proto=${protoTag(value)},frozen=${String(Object.isFrozen(value))}`];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") {
      parts.push(`|sym(${String(key)})`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    const flags = `${descriptor.enumerable === true ? "e" : "-"}${descriptor.writable === true ? "w" : "-"}${descriptor.configurable === true ? "c" : "-"}${Object.hasOwn(descriptor, "value") ? "v" : "a"}`;
    parts.push(`|${key}:${flags}=${strictShape(descriptor.value)}`);
  }
  return `${parts.join("")}}`;
}

/** What the record SAYS, independent of how it says it. */
function valueShape(value: unknown): string {
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map((item) => valueShape(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${key}=${valueShape((value as Row)[key])}`).join(",")}}`;
}

function digestRows(): { readonly value: readonly string[]; readonly strict: readonly string[] } {
  const value: string[] = [];
  const strict: string[] = [];
  for (const [label, spec, observation] of EVALUATION_ROWS) {
    let rendered: unknown;
    try {
      rendered = evaluateSettlement(spec, observation as never);
    } catch (error) {
      rendered = `THREW ${(error as Error).name}: ${(error as Error).message}`;
    }
    value.push(`eval ${label} ${valueShape(rendered)}`);
    strict.push(`eval ${label} ${strictShape(rendered)}`);
  }
  for (const outcome of [
    "YES_WIN",
    "NO_WIN",
    "SPLIT_50_50",
    "CANCELLED",
    "PENDING",
    "PENDING_CLARIFICATION",
    "DISPUTED",
  ] as const) {
    const result = payoutPerShare(outcome);
    value.push(`payout ${outcome} ${valueShape(result)}`);
    strict.push(`payout ${outcome} ${strictShape(result)}`);
  }
  for (const observationType of OBSERVATION_TYPES) {
    for (const payoffModel of PAYOFF_MODEL_IDS) {
      const bare = checkPayoffModelCompatibility({ observationType, payoffModel });
      const full = checkPayoffModelCompatibility({
        observationType,
        payoffModel,
        comparison: "GT",
        windowSeconds: 30,
        windowStartRule: "start",
        windowEndRule: "end",
        strikeSource: "strike",
        referenceOpenSource: "open",
      });
      value.push(`compat ${observationType}/${payoffModel} ${valueShape(bare)} ${valueShape(full)}`);
      strict.push(`compat ${observationType}/${payoffModel} ${strictShape(bare)} ${strictShape(full)}`);
    }
    const noModel = checkPayoffModelCompatibility({ observationType });
    value.push(`compat ${observationType}/none ${valueShape(noModel)}`);
    strict.push(`compat ${observationType}/none ${strictShape(noModel)}`);
  }
  for (const [label, spec] of [
    ["terminal-spot", terminalSpot],
    ["twap", twap],
    ["updown", upDown],
    ["threshold", thresholdByDate],
    ["modelless", modelless],
  ] as const) {
    const selected = selectPayoffModel(spec);
    value.push(`select ${label} ${valueShape(selected)}`);
    strict.push(`select ${label} ${strictShape(selected)}`);
  }
  return { value, strict };
}

function sha256(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}
