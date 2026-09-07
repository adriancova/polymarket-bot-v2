/**
 * REGRESSION: a settlement spec's DECLARED fields must be its OWN
 * (`docs/contracts/schema-boundary.md` §3, the `packages/settlement` row —
 * probe N, HIGH; ADR-020 §1 class 1 and §3).
 *
 * MEASURED AT BASE `78ec81d`, reproduce-first, and every row below failed there
 * before it was closed:
 *
 * - **The 14-key sweep.** Of the sixteen own keys of `terminalSpotSpecSample()`,
 *   FOURTEEN are required — deleting any one is refused clean — and ALL
 *   FOURTEEN parse when only `Object.prototype` supplies them. Twelve are
 *   required by the shape; `comparison` and `strikeSource` are required of this
 *   spec by the payoff-model compatibility rule.
 * - **`resolutionSource`.** An adopted one is a spec that settles against a
 *   source its own text never named (`"Some source the spec never named."`
 *   landed in `spec.resolutionSource` at base).
 * - **`verification`, the sharpest cell.** A spec carrying NO verification key
 *   at all, under an inherited
 *   `{status:"VERIFIED", verifiedBy:"attacker", verifiedAt:"2026-08-28T00:00:00Z"}`
 *   (or an inherited `{}` plus inherited `status`/`verifiedBy`/`verifiedAt`),
 *   parsed as `{"status":"VERIFIED", …}`, `isReviewedSettlementSpec` returned
 *   `true`, `classifySettlementActivation` returned
 *   `REVIEWED_MODEL_BACKED` / `modelDependentActivationAllowed:true`, and
 *   `evaluateSettlement` stamped `reviewed:true` on the settlement it computed
 *   (`registry.ts`'s one non-test call site).
 * - **The refusal that could not be built.** An inherited `_zod`, `path` or
 *   `value` made `safeParseSettlementSpec` — documented not to throw — THROW a
 *   `TypeError`, and took `classifySettlementActivation` with it (ADR-020
 *   amendment 2026-09-06).
 * - **D2's absence.** One inherited `skipChecks` admitted a malformed
 *   `settlementSpecId`, a placeholder `roundingRule` (ADR-009 §5.4), an
 *   untrimmed rule, a `specVersion` of `0` and of `-3.5`, an empty
 *   `referenceSymbol`, an empty `verifiedBy`, a `verifiedAt` of `"not-a-time"`,
 *   and the one combination §9.3 states by name — a TWAP spec selecting
 *   `TerminalSpotBinaryModel`.
 *
 * BOTH POLLUTION VARIANTS ARE PINNED. The NON-ENUMERABLE one is the variant to
 * design against (`schema-boundary.md` §2) and the one every adoption above was
 * measured with. The ENUMERABLE one was refused at base too — but by an
 * ACCIDENT, not a defence: `strictObject` reported the inherited key as
 * `verification: Unrecognized key: "roundingRule"`, i.e. the NESTED verification
 * object saw it. REC-1's review round 1 (finding F1) showed what that accident
 * costs: an enumerable-copy materializer mutant reopened a whole row with the
 * suite green. So the enumerable sweep is run here on the door's own terms.
 *
 * DEPLOYMENT READING, required whenever the §3 row is quoted: nothing on the
 * wire can write `Object.prototype`; every class above needs code already
 * executing in the process. The row states the check is not load-bearing
 * against an attacker already inside the process, not that a caller can turn it
 * off. It matters because this door is the only enforcement of a review gate
 * whose failure mode is a payout, and because §6 invariant 9 and ADR-009 §5.4
 * rest on it.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { classifySettlementActivation } from "./activation.js";
import { settlementRefusal } from "./errors.js";
import { evaluateSettlement } from "./models/registry.js";
import { readOwnSpec } from "./spec-door.js";
import {
  isReviewedSettlementSpec,
  parseSettlementSpec,
  REQUIRED_SETTLEMENT_SPEC_KEYS,
  safeParseSettlementSpec,
  SETTLEMENT_SPEC_KEYS,
  settlementSpecOwnIssues,
  settlementSpecReviewBlockers,
  settlementSpecShape,
  settlementVerificationStatus,
  type SettlementSpec,
} from "./spec.js";
import {
  referenceOpenUpDownSpecSample,
  terminalSpotObservationSample,
  terminalSpotSpecSample,
  thresholdByDateSpecSample,
  twapSpecSample,
  verifiedSpec,
} from "./testing/index.js";

const publishedWindows = { publishedWindowSeconds: [30, 60] } as const;

/**
 * WARM FIRST, ALWAYS. Enumerable pollution present during a schema's FIRST
 * parse aborts its lazy build and permanently poisons it (ADR-020 §1 class 7),
 * which would make this file measure the poisoning instead of the adoption.
 */
function warm(): void {
  safeParseSettlementSpec(terminalSpotSpecSample());
  safeParseSettlementSpec(twapSpecSample());
  safeParseSettlementSpec({});
}
warm();

function withInherited<T>(entries: readonly (readonly [string, unknown])[], body: () => T): T {
  for (const [key, value] of entries) {
    Object.defineProperty(Object.prototype, key, {
      value,
      enumerable: false,
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

/** The ENUMERABLE variant of the same class (REC-1 review round 1, finding F1). */
function withInheritedEnumerable<T>(entries: readonly (readonly [string, unknown])[], body: () => T): T {
  warm();
  for (const [key, value] of entries) {
    Object.defineProperty(Object.prototype, key, {
      value,
      enumerable: true,
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

function asRecord(spec: SettlementSpec): Record<string, unknown> {
  return { ...(spec as unknown as Record<string, unknown>) };
}

function without(spec: SettlementSpec, key: string): Record<string, unknown> {
  const copy = asRecord(spec);
  delete copy[key];
  return copy;
}

/** The four §9.3 sample specs: the audit reached one, this file sweeps all four. */
const SAMPLE_SPECS: readonly (readonly [string, () => SettlementSpec])[] = [
  ["terminalSpot", terminalSpotSpecSample],
  ["twap", twapSpecSample],
  ["referenceOpenUpDown", referenceOpenUpDownSpecSample],
  ["thresholdByDate", thresholdByDateSpecSample],
];

describe("the settlement spec door: no declared field comes from the prototype", () => {
  // ---------------------------------------------------------------------
  // The measured row: the required-key sweep, both variants.
  // ---------------------------------------------------------------------

  it("the census the §3 row rests on: 16 own keys, 14 of them required", () => {
    const sample = terminalSpotSpecSample();
    expect(Object.keys(asRecord(sample))).toHaveLength(16);

    const required = Object.keys(asRecord(sample)).filter(
      (key) => !safeParseSettlementSpec(without(sample, key)).ok,
    );
    expect(required.sort()).toEqual(
      [
        "clarificationPolicy",
        "comparison",
        "disputePolicy",
        "fallbackSource",
        "observationType",
        "referenceSymbol",
        "resolutionSource",
        "roundingRule",
        "seriesId",
        "settlementSpecId",
        "specVersion",
        "strikeSource",
        "timestampBoundary",
        "verification",
      ].sort(),
    );
    expect(required).toHaveLength(14);
  });

  it("EVERY required key is refused when only the prototype supplies it (non-enumerable)", () => {
    const sample = terminalSpotSpecSample();
    const source = asRecord(sample);
    const survivors: string[] = [];
    for (const key of Object.keys(source)) {
      const raw = without(sample, key);
      const clean = safeParseSettlementSpec(raw);
      const polluted = withInherited([[key, source[key]]], () => safeParseSettlementSpec(raw));
      if (!clean.ok && polluted.ok) {
        survivors.push(`${key} (adopted)`);
      }
      // The two OPTIONAL keys parse without their value — but must not carry
      // the prototype's.
      if (clean.ok && polluted.ok) {
        const adopted = (polluted.spec as unknown as Record<string, unknown>)[key];
        if (adopted !== undefined) survivors.push(`${key} (optional, adopted ${String(adopted)})`);
      }
    }
    expect(survivors).toEqual([]);
  });

  it("…and under the ENUMERABLE variant too (REC-1 F1: the enumerable-copy mutant)", () => {
    const sample = terminalSpotSpecSample();
    const source = asRecord(sample);
    const survivors: string[] = [];
    for (const key of Object.keys(source)) {
      const raw = without(sample, key);
      const clean = safeParseSettlementSpec(raw);
      const polluted = withInheritedEnumerable([[key, source[key]]], () =>
        safeParseSettlementSpec(raw),
      );
      if (!clean.ok && polluted.ok) survivors.push(`${key} (adopted)`);
      if (clean.ok && polluted.ok) {
        const adopted = (polluted.spec as unknown as Record<string, unknown>)[key];
        if (adopted !== undefined) survivors.push(`${key} (optional, adopted ${String(adopted)})`);
      }
    }
    expect(survivors).toEqual([]);
  });

  // The audit reached ONE sample (`schema-boundary.md` §5 item 7: "each owner
  // must probe the doors this audit did not reach … and specs other than the
  // sampled one"). All four §9.3 shapes are the same class.
  it("the same sweep over all four sample specs, both variants", () => {
    const survivors: string[] = [];
    for (const [label, build] of SAMPLE_SPECS) {
      const sample = build();
      const source = asRecord(sample);
      for (const key of Object.keys(source)) {
        const raw = without(sample, key);
        const clean = safeParseSettlementSpec(raw);
        for (const [variant, pollute] of [
          ["non-enumerable", withInherited],
          ["enumerable", withInheritedEnumerable],
        ] as const) {
          const polluted = pollute([[key, source[key]]], () => safeParseSettlementSpec(raw));
          if (!clean.ok && polluted.ok) survivors.push(`${label}.${key} (${variant})`);
          if (clean.ok && polluted.ok) {
            const adopted = (polluted.spec as unknown as Record<string, unknown>)[key];
            if (adopted !== undefined) survivors.push(`${label}.${key} optional (${variant})`);
          }
        }
      }
    }
    expect(survivors).toEqual([]);
  });

  it("an adopted `resolutionSource` cannot become the source a spec settles against", () => {
    const raw = without(terminalSpotSpecSample(), "resolutionSource");
    const invented = "Some source the spec never named.";
    for (const [variant, pollute] of [
      ["non-enumerable", withInherited],
      ["enumerable", withInheritedEnumerable],
    ] as const) {
      const parsed = pollute([["resolutionSource", invented]], () => safeParseSettlementSpec(raw));
      expect(parsed.ok, variant).toBe(false);
      const verdict = pollute([["resolutionSource", invented]], () =>
        classifySettlementActivation({ spec: raw }),
      );
      expect(verdict.status, variant).toBe("SPEC_INVALID");
      expect(verdict.modelDependentActivationAllowed, variant).toBe(false);
    }
  });

  // ---------------------------------------------------------------------
  // The VERIFIED-from-nothing route, END TO END.
  // ---------------------------------------------------------------------

  describe("the review gate cannot be satisfied by the prototype (end to end)", () => {
    const ADOPTABLE_VERIFICATIONS: readonly (readonly [
      string,
      readonly (readonly [string, unknown])[],
    ])[] = [
      [
        "a whole verification block",
        [
          [
            "verification",
            { status: "VERIFIED", verifiedBy: "attacker", verifiedAt: "2026-08-28T00:00:00Z" },
          ],
        ],
      ],
      [
        "an empty block whose own fields are inherited too",
        [
          ["verification", {}],
          ["status", "VERIFIED"],
          ["verifiedBy", "attacker"],
          ["verifiedAt", "2026-08-28T00:00:00Z"],
        ],
      ],
      ["only a status", [["verification", { status: "VERIFIED" }]]],
    ];

    it("a spec with NO verification key is refused at the parse, under either variant", () => {
      const raw = without(terminalSpotSpecSample(), "verification");
      expect(safeParseSettlementSpec(raw).ok).toBe(false);
      for (const [label, entries] of ADOPTABLE_VERIFICATIONS) {
        for (const [variant, pollute] of [
          ["non-enumerable", withInherited],
          ["enumerable", withInheritedEnumerable],
        ] as const) {
          const parsed = pollute(entries, () => safeParseSettlementSpec(raw));
          expect(parsed.ok, `${label} / ${variant}`).toBe(false);
        }
      }
    });

    it("…and BOTH activation gates refuse it, with the registry's `reviewed` false", () => {
      const raw = without(terminalSpotSpecSample(), "verification");
      for (const [label, entries] of ADOPTABLE_VERIFICATIONS) {
        for (const [variant, pollute] of [
          ["non-enumerable", withInherited],
          ["enumerable", withInheritedEnumerable],
        ] as const) {
          const verdict = pollute(entries, () =>
            classifySettlementActivation({ spec: raw, reviewContext: publishedWindows }),
          );
          expect(verdict.status, `${label} / ${variant}`).not.toBe("REVIEWED_MODEL_BACKED");
          expect(verdict.modelDependentActivationAllowed, `${label} / ${variant}`).toBe(false);
        }
      }
    });

    // The gates and the registry call site are reachable with a spec object the
    // caller built, not only through the parse. `isReviewedSettlementSpec` is
    // EXPORTED and takes a `SettlementSpec`; `registry.ts`'s `evaluation()`
    // calls it for every settlement it computes. Both must read the document.
    it("`isReviewedSettlementSpec` reads the document, not the chain", () => {
      const noVerification = without(terminalSpotSpecSample(), "verification") as unknown as SettlementSpec;
      for (const [label, entries] of ADOPTABLE_VERIFICATIONS) {
        for (const [variant, pollute] of [
          ["non-enumerable", withInherited],
          ["enumerable", withInheritedEnumerable],
        ] as const) {
          expect(
            pollute(entries, () => isReviewedSettlementSpec(noVerification)),
            `${label} / ${variant}`,
          ).toBe(false);
          expect(
            pollute(entries, () => settlementVerificationStatus(noVerification)),
            `${label} / ${variant}`,
          ).toBeUndefined();
        }
      }
      // A real UNVERIFIED spec cannot be upgraded by the prototype either.
      const unverified = parseSettlementSpec(terminalSpotSpecSample());
      expect(withInherited([["status", "VERIFIED"]], () => isReviewedSettlementSpec(unverified))).toBe(
        false,
      );
    });

    it("`evaluateSettlement` never stamps `reviewed:true` from the prototype (registry.ts call site)", () => {
      const noVerification = without(terminalSpotSpecSample(), "verification") as unknown as SettlementSpec;
      for (const [label, entries] of ADOPTABLE_VERIFICATIONS) {
        const result = withInherited(entries, () =>
          evaluateSettlement(noVerification, terminalSpotObservationSample()),
        );
        expect(result.ok, label).toBe(true);
        if (!result.ok) throw new Error("unreachable");
        expect(result.value.reviewed, label).toBe(false);
      }
      // …and an honestly verified spec still reports the truth.
      const honest = parseSettlementSpec(verifiedSpec(terminalSpotSpecSample()));
      const honestResult = evaluateSettlement(honest, terminalSpotObservationSample());
      expect(honestResult.ok).toBe(true);
      if (!honestResult.ok) throw new Error("unreachable");
      expect(honestResult.value.reviewed).toBe(true);
    });

    // §6 invariant 9's other half: the SPEC_VERIFICATION_UNSOUND gate asks
    // whether the review named the rules version it reviewed. An inherited
    // `rulesVersionId` answers that gate on a spec that names none.
    it("the `rulesVersionId` review blocker cannot be answered by the prototype", () => {
      const raw = without(verifiedSpec(terminalSpotSpecSample()), "rulesVersionId");
      for (const [variant, pollute] of [
        ["non-enumerable", withInherited],
        ["enumerable", withInheritedEnumerable],
      ] as const) {
        const verdict = pollute([["rulesVersionId", "01936f00-0000-7000-8000-00000000b001"]], () =>
          classifySettlementActivation({ spec: raw }),
        );
        expect(verdict.status, variant).toBe("SPEC_VERIFICATION_UNSOUND");
        expect(verdict.modelDependentActivationAllowed, variant).toBe(false);
      }
      const spec = parseSettlementSpec(raw);
      expect(
        withInherited([["rulesVersionId", "01936f00-0000-7000-8000-00000000b001"]], () =>
          settlementSpecReviewBlockers(spec).map((blocker) => blocker.code),
        ),
      ).toContain("SETTLEMENT_RULES_VERSION_REQUIRED");
    });

    // ADR-009 §6: a window nothing publishes cannot be verified, and the
    // published list is the CALLER's context object.
    it("an inherited `publishedWindowSeconds` cannot publish a window", () => {
      const raw = { ...asRecord(verifiedSpec(twapSpecSample())), windowSeconds: 45 };
      const verdict = withInherited([["publishedWindowSeconds", [45]]], () =>
        classifySettlementActivation({ spec: raw, reviewContext: {} }),
      );
      expect(verdict.status).toBe("SPEC_VERIFICATION_UNSOUND");
      expect(verdict.refusals.map((refusal) => refusal.code)).toContain(
        "SETTLEMENT_PUBLISHED_WINDOWS_UNKNOWN",
      );
    });
  });

  // ---------------------------------------------------------------------
  // The activation input itself (activation.ts:128's caller side).
  // ---------------------------------------------------------------------

  it("a series with NO spec bound cannot be given one by the prototype", () => {
    for (const [variant, pollute] of [
      ["non-enumerable", withInherited],
      ["enumerable", withInheritedEnumerable],
    ] as const) {
      const verdict = pollute([["spec", verifiedSpec(terminalSpotSpecSample())]], () =>
        classifySettlementActivation({}),
      );
      expect(verdict.status, variant).toBe("SPEC_MISSING");
      expect(verdict.modelDependentActivationAllowed, variant).toBe(false);
      expect(
        pollute([["spec", verifiedSpec(terminalSpotSpecSample())]], () =>
          classifySettlementActivation(),
        ).status,
        `${variant} (no argument)`,
      ).toBe("SPEC_MISSING");
    }
  });

  // ---------------------------------------------------------------------
  // ADR-020's 2026-09-06 amendment: the refusal CONSTRUCTION is contained.
  // ---------------------------------------------------------------------

  it("a refusal that cannot be CONSTRUCTED is still a refusal, not a throw", () => {
    // At base, `_zod` → `TypeError: Cannot read properties of undefined
    // (reading 'has')`, `path` → `iss.path is not iterable`, `value` →
    // `Invalid property descriptor…`, each escaping a function documented not
    // to throw. `message` refused cleanly and is kept as the control.
    const raw = without(terminalSpotSpecSample(), "roundingRule");
    for (const key of ["_zod", "message", "path", "value"] as const) {
      const parsed = withInherited([[key, {}]], () => safeParseSettlementSpec(raw));
      expect(parsed.ok, key).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.refusal.code, key).toBe("SETTLEMENT_SPEC_INVALID");
      // Composition MAY vary (ADR-020 §6); that a verdict came back may not.
      expect(typeof parsed.refusal.message, key).toBe("string");

      const verdict = withInherited([[key, {}]], () => classifySettlementActivation({ spec: raw }));
      expect(verdict.status, key).toBe("SPEC_INVALID");
      expect(verdict.modelDependentActivationAllowed, key).toBe(false);

      // The throwing entry point must throw its OWN typed error, never a
      // `TypeError` from inside the library.
      expect(
        withInherited([[key, {}]], () => {
          try {
            parseSettlementSpec(raw);
            return "parsed";
          } catch (error: unknown) {
            return (error as Error).name;
          }
        }),
        key,
      ).toBe("SettlementSpecValidationError");
    }
  });

  it("the same containment holds for a VALID spec under the same hostile shapes", () => {
    const honest = verifiedSpec(terminalSpotSpecSample());
    for (const key of ["_zod", "message", "path", "value"] as const) {
      const verdict = withInherited([[key, {}]], () =>
        classifySettlementActivation({ spec: honest, reviewContext: publishedWindows }),
      );
      // Permission may not vary (ADR-020 §6). Either the door refuses (fail
      // closed) or it returns the honest verdict; it never throws and never
      // permits something it would not have permitted clean.
      expect(["REVIEWED_MODEL_BACKED", "SPEC_INVALID"], key).toContain(verdict.status);
    }
  });

  // ---------------------------------------------------------------------
  // D2 is NOT performed. This is what the door has instead of an arena.
  // ---------------------------------------------------------------------

  describe("D2-independence: the door's own rules are not switchable off", () => {
    it("every rule the schema declares still refuses with `skipChecks` inherited", () => {
      const sample = terminalSpotSpecSample();
      const survivors: string[] = [];
      const cases: readonly (readonly [string, unknown])[] = [
        ["a malformed settlementSpecId", { ...asRecord(sample), settlementSpecId: "NOT-A-UUID" }],
        ["an uppercase UUID", { ...asRecord(sample), seriesId: "01936F00-0000-7000-8000-00000000A001" }],
        ["a placeholder roundingRule (ADR-009 §5.4)", { ...asRecord(sample), roundingRule: "TBD" }],
        ["a two-character rule", { ...asRecord(sample), roundingRule: "x" }],
        ["an untrimmed rule", { ...asRecord(sample), roundingRule: "  padded rule  " }],
        ["a specVersion of 0", { ...asRecord(sample), specVersion: 0 }],
        ["a specVersion of -3.5", { ...asRecord(sample), specVersion: -3.5 }],
        ["an empty referenceSymbol", { ...asRecord(sample), referenceSymbol: "" }],
        ["a whitespace referenceSymbol", { ...asRecord(sample), referenceSymbol: "btc usd" }],
        ["an unknown observationType", { ...asRecord(sample), observationType: "ORACLE_GUESS" }],
        ["an unknown payoffModel", { ...asRecord(sample), payoffModel: "GuessModel" }],
        [
          "an empty verifiedBy",
          {
            ...asRecord(sample),
            verification: { status: "VERIFIED", verifiedBy: "", verifiedAt: "2026-08-28T00:00:00Z" },
          },
        ],
        [
          "a malformed verifiedAt",
          {
            ...asRecord(sample),
            verification: { status: "VERIFIED", verifiedBy: "r", verifiedAt: "not-a-time" },
          },
        ],
        [
          "an impossible calendar verifiedAt",
          {
            ...asRecord(sample),
            verification: {
              status: "VERIFIED",
              verifiedBy: "r",
              verifiedAt: "2026-02-30T00:00:00Z",
            },
          },
        ],
        [
          "a reviewer named on an UNVERIFIED block",
          { ...asRecord(sample), verification: { status: "UNVERIFIED", verifiedBy: "r" } },
        ],
        ["an unknown verification status", { ...asRecord(sample), verification: { status: "MAYBE" } }],
        ["an unrecognized field", { ...asRecord(sample), backdoor: "yes" }],
        // The one combination §9.3 states by name.
        [
          "a TWAP spec selecting the terminal-spot model",
          { ...asRecord(twapSpecSample()), payoffModel: "TerminalSpotBinaryModel" },
        ],
        ["a TWAP spec with no window", without(twapSpecSample(), "windowSeconds")],
        ["a windowed spec with no boundary rules", without(twapSpecSample(), "windowStartRule")],
        ["a terminal-spot spec with no strike source", without(sample, "strikeSource")],
      ];
      for (const [label, value] of cases) {
        const clean = safeParseSettlementSpec(value);
        if (clean.ok) survivors.push(`${label} (clean!)`);
        const skipped = withInherited([["skipChecks", true]], () => safeParseSettlementSpec(value));
        if (skipped.ok) survivors.push(`${label} (skipChecks)`);
        const whenSkipped = withInherited([["when", false]], () => safeParseSettlementSpec(value));
        if (whenSkipped.ok) survivors.push(`${label} (when)`);
      }
      expect(survivors).toEqual([]);
    });

    it("the required-key sweep also holds with every zod check disabled", () => {
      const sample = terminalSpotSpecSample();
      const source = asRecord(sample);
      const survivors: string[] = [];
      for (const key of Object.keys(source)) {
        const raw = without(sample, key);
        if (safeParseSettlementSpec(raw).ok) continue; // an optional key
        const polluted = withInherited(
          [
            [key, source[key]],
            ["skipChecks", true],
            ["optin", "optional"],
            ["optout", "optional"],
            ["when", false],
          ],
          () => safeParseSettlementSpec(raw),
        );
        if (polluted.ok) survivors.push(key);
      }
      expect(survivors).toEqual([]);
    });

    // THE PRESENCE HALF, measured on the door's own contract.
    //
    // Every other restated rule above is reachable through the door under an
    // inherited `skipChecks`. The required-key half is NOT, and the reason is
    // worth recording: at `zod@4.4.3` the `optin`/`optout` waiver (ADR-020 §1
    // class 5) is live — a `strictObject` of two required strings, built while
    // the pair is inherited, ACCEPTS a value missing one of them — but it does
    // not reach `SettlementSpecSchema`, cold or warm (measured four ways:
    // repeated cold parses through the door, repeated cold parses of the raw
    // schema, a schema warmed under the pollution, and a fresh two-key
    // control which IS waived). So the restatement is pinned on its own
    // contract, as REC-1 pinned `readOwnConfig`'s: a compensation nobody
    // measures is a claim, not a defence.
    it("the required-key restatement refuses on its own, and the waiver it answers is REAL", () => {
      const waiver = [
        ["optin", "optional"],
        ["optout", "optional"],
      ] as const;

      // The control: the library's own required-key enforcement, waived.
      const waived = withInherited(waiver, () => {
        const control = z.strictObject({ kept: z.string(), dropped: z.string() });
        return control.safeParse({ kept: "here" }).success;
      });
      expect(waived, "the optin/optout waiver is no longer live at this zod version").toBe(true);

      // …and this schema, which the waiver does NOT reach — stated as measured,
      // not assumed, because it is the reason for the pin below.
      expect(
        withInherited(waiver, () =>
          safeParseSettlementSpec(without(terminalSpotSpecSample(), "roundingRule")).ok,
        ),
      ).toBe(false);

      // The door's own presence check, on the materialized tree.
      const sample = terminalSpotSpecSample();
      const unnamed: string[] = [];
      for (const key of REQUIRED_SETTLEMENT_SPEC_KEYS) {
        const read = readOwnSpec(without(sample, key));
        expect(read.ok, key).toBe(true);
        if (!read.ok) throw new Error("unreachable");
        const issues = settlementSpecOwnIssues(read.value);
        if (!issues.some((issue) => issue.startsWith(`${key}: `))) unnamed.push(key);
      }
      expect(unnamed).toEqual([]);
      // The whole document, honest, states no issue at all.
      const honest = readOwnSpec(verifiedSpec(sample));
      expect(honest.ok).toBe(true);
      if (!honest.ok) throw new Error("unreachable");
      expect(settlementSpecOwnIssues(honest.value)).toEqual([]);
    });

    it("the door's required-key table is the schema's own (derived, not trusted)", () => {
      const derived = SETTLEMENT_SPEC_KEYS.filter((key) => {
        const field = settlementSpecShape[key as keyof typeof settlementSpecShape];
        return field.safeParse(undefined).success === false;
      });
      expect([...REQUIRED_SETTLEMENT_SPEC_KEYS].sort()).toEqual([...derived].sort());
      // …and every declared key has a restated rule: a shape key the door
      // states no rule for is refused, so the census cannot silently shrink.
      expect(SETTLEMENT_SPEC_KEYS).toHaveLength(20);
      for (const key of SETTLEMENT_SPEC_KEYS) {
        const sample = asRecord(terminalSpotSpecSample());
        const probe = { ...sample, [key]: Symbol.iterator };
        expect(safeParseSettlementSpec(probe).ok, key).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------
  // D4: what the door emits.
  // ---------------------------------------------------------------------

  it("every emitted record has a null prototype (D4)", () => {
    const spec = parseSettlementSpec(verifiedSpec(terminalSpotSpecSample()));
    expect(Object.getPrototypeOf(spec)).toBeNull();
    expect(Object.getPrototypeOf(spec.verification)).toBeNull();
    expect(Object.isFrozen(spec)).toBe(true);

    for (const input of [
      verifiedSpec(terminalSpotSpecSample()),
      terminalSpotSpecSample(),
      { settlementSpecId: "not-a-uuid" },
      42,
      undefined,
    ]) {
      const verdict = classifySettlementActivation({ spec: input });
      expect(Object.getPrototypeOf(verdict), String(verdict.status)).toBeNull();
      expect(Object.isFrozen(verdict), String(verdict.status)).toBe(true);
      for (const refusal of verdict.refusals) {
        expect(Object.getPrototypeOf(refusal), refusal.code).toBeNull();
        expect(Object.getPrototypeOf(refusal.details), refusal.code).toBeNull();
      }
    }

    // …so an absent field reads as absent whatever the prototype says.
    const noModel = parseSettlementSpec({
      ...without(terminalSpotSpecSample(), "payoffModel"),
      observationType: "MANUAL_ORACLE",
    });
    expect(
      withInherited([["payoffModel", "TerminalSpotBinaryModel"]], () => noModel.payoffModel),
    ).toBeUndefined();
    const verdict = classifySettlementActivation({ spec: terminalSpotSpecSample() });
    expect(
      withInherited([["payoffModel", "TerminalSpotBinaryModel"]], () => verdict.rulesVersionId),
    ).toBe("01936f00-0000-7000-8000-00000000b001");
    expect(
      withInherited([["nothingCarriesThis", "invented"]], () =>
        Object.hasOwn(verdict, "nothingCarriesThis"),
      ),
    ).toBe(false);
    // A refusal built by this package is prototype-free on its own account.
    expect(Object.getPrototypeOf(settlementRefusal("SETTLEMENT_SPEC_MISSING", "x"))).toBeNull();
  });

  // ---------------------------------------------------------------------
  // D1: what the materializer refuses, and that it materializes at all.
  // ---------------------------------------------------------------------

  it("D1 builds a NEW prototype-free tree rather than handing the input over", () => {
    const sample = terminalSpotSpecSample();
    const read = readOwnSpec(sample);
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.value).not.toBe(sample);
    expect(Object.getPrototypeOf(read.value as object)).toBeNull();
    expect(Object.getPrototypeOf((read.value as Record<string, unknown>)["verification"] as object))
      .toBeNull();
    // Identity is not preserved for nested records either — a shared reference
    // would let the caller mutate the tree after it was judged.
    expect((read.value as Record<string, unknown>)["verification"]).not.toBe(sample.verification);
  });

  it("values a reviewed document cannot carry are refused rather than copied", () => {
    const sample = asRecord(terminalSpotSpecSample());
    const withAccessor: Record<string, unknown> = { ...sample };
    Object.defineProperty(withAccessor, "roundingRule", {
      get: () => "No rounding: the exact decimal observation is compared as published.",
      enumerable: true,
      configurable: true,
    });
    const inherited = Object.create({ roundingRule: "inherited" }) as Record<string, unknown>;
    for (const key of Object.keys(sample)) inherited[key] = sample[key];

    for (const [label, value] of [
      ["an accessor field", withAccessor],
      ["a foreign prototype", inherited],
      ["a symbol-keyed field", { ...sample, [Symbol("x")]: 1 }],
      ["a function field", { ...sample, roundingRule: (): string => "x" }],
      ["a cycle", (() => {
        const cyclic: Record<string, unknown> = { ...sample };
        cyclic["self"] = cyclic;
        return cyclic;
      })()],
    ] as const) {
      expect(safeParseSettlementSpec(value).ok, label).toBe(false);
    }

    // An own `__proto__` field: the one name a copy cannot carry faithfully.
    const withProtoKey = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(sample).slice(1)}`,
    ) as unknown;
    expect(safeParseSettlementSpec(withProtoKey).ok).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Honest input is unchanged. This is the property the door must not buy
  // its refusals with.
  // ---------------------------------------------------------------------

  it("an honest spec parses to the same document under either pollution variant", () => {
    for (const [label, build] of SAMPLE_SPECS) {
      const honest = verifiedSpec(build());
      const clean = safeParseSettlementSpec(honest);
      expect(clean.ok, label).toBe(true);
      if (!clean.ok) throw new Error("unreachable");
      const cleanJson = JSON.stringify(clean.spec);
      // The emitted key order is the schema's own shape order, unchanged.
      expect(cleanJson, label).toBe(JSON.stringify(clean.spec));
      for (const [variant, pollute] of [
        ["non-enumerable", withInherited],
        ["enumerable", withInheritedEnumerable],
      ] as const) {
        const polluted = pollute(
          [
            ["resolutionSource", "INVENTED"],
            ["payoffModel", "TwapBinaryModel"],
            ["rulesVersionId", "01936f00-0000-7000-8000-0000000000ff"],
          ],
          () => safeParseSettlementSpec(honest),
        );
        expect(polluted.ok, `${label} / ${variant}`).toBe(true);
        if (!polluted.ok) throw new Error("unreachable");
        expect(JSON.stringify(polluted.spec), `${label} / ${variant}`).toBe(cleanJson);
      }
    }
  });

  it("an honest verdict is byte-identical under pollution (permission never varies)", () => {
    const cases: readonly (readonly [string, unknown])[] = [
      ["verified terminal spot", verifiedSpec(terminalSpotSpecSample())],
      ["unverified terminal spot", terminalSpotSpecSample()],
      ["verified twap", verifiedSpec(twapSpecSample())],
      ["rejected", { ...asRecord(terminalSpotSpecSample()), verification: { status: "REJECTED" } }],
      ["invalid", { settlementSpecId: "not-a-uuid" }],
      ["missing", undefined],
    ];
    for (const [label, spec] of cases) {
      const clean = JSON.stringify(
        classifySettlementActivation({ spec, reviewContext: publishedWindows }),
      );
      for (const [variant, pollute] of [
        ["non-enumerable", withInherited],
        ["enumerable", withInheritedEnumerable],
      ] as const) {
        const polluted = pollute(
          [
            ["rulesVersionId", "01936f00-0000-7000-8000-0000000000ff"],
            ["payoffModel", "TwapBinaryModel"],
            ["publishedWindowSeconds", [45]],
          ],
          () => JSON.stringify(classifySettlementActivation({ spec, reviewContext: publishedWindows })),
        );
        expect(polluted, `${label} / ${variant}`).toBe(clean);
      }
    }
  });
});
