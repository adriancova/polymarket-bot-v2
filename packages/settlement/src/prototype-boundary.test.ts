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

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { classifySettlementActivation } from "./activation.js";
import type * as ActivationModule from "./activation.js";
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
  SettlementSpecSchema,
  settlementVerificationStatus,
  type SettlementSpec,
} from "./spec.js";
import type * as SpecModule from "./spec.js";
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

/**
 * The ASYNC-CORRECT form, for the cold-module rows.
 *
 * REMEDIATION NOTE: {@link withInherited} takes a synchronous body. Handing it
 * an `async` one installs the pollution, receives a PROMISE, and deletes the
 * pollution in `finally` before the awaited work has run — which is exactly how
 * round 1 concluded, wrongly, that the `optin`/`optout` waiver does not reach
 * this schema. This version awaits inside the `try`.
 */
async function withInheritedAsync<T>(
  entries: readonly (readonly [string, unknown])[],
  body: () => Promise<T>,
): Promise<T> {
  for (const [key, value] of entries) {
    Object.defineProperty(Object.prototype, key, {
      value,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }
  try {
    return await body();
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

/**
 * The `verifiedAt` corpus for the B1 differential sweep: every offset and time
 * spelling that distinguishes the schema's grammar from a hand-written one.
 * Both verdicts are represented (19 of the 51 are accepted by the schema), so
 * the equality assertion cannot pass vacuously.
 */
const ISO_INSTANT_CASES: readonly string[] = [
  // Accepted by `z.iso.datetime({ offset: true })`.
  "2026-08-28T00:00:00Z",
  "2026-08-28T00:00:00.123Z",
  "2026-08-28T00:00:00.123456789Z",
  "2026-08-28T00:00Z",
  "2026-08-28T00:00+02:00",
  "2026-08-28T00:00:00+00:00",
  "2026-08-28T00:00:00-00:00",
  "2026-08-28T00:00:00+23:59",
  "2026-08-28T00:00:00-23:59",
  "2026-08-28T00:00:00+05:30",
  "2026-08-28T00:00:00+14:00",
  "2026-08-28T00:00:00-12:45",
  "2026-08-28T23:59:59Z",
  "2024-02-29T00:00:00Z",
  "2000-02-29T00:00:00Z",
  "0000-01-01T00:00:00Z",
  "0050-06-15T00:00:00Z",
  "0099-12-31T00:00:00Z",
  "1900-01-01T00:00:00Z",
  // The B1 fail-open set: offsets the schema bounds at ±23:59.
  "2026-08-28T00:00:00+24:00",
  "2026-08-28T00:00:00-24:00",
  "2026-08-28T00:00:00+99:99",
  "2026-08-28T00:00:00-99:99",
  "2026-08-28T00:00:00+00:60",
  "2026-08-28T00:00:00+00:99",
  "2026-08-28T00:00:00+25:00",
  "2026-08-28T00:00:00-00:60",
  "2026-08-28T00:00:00+90:00",
  // Malformed offsets.
  "2026-08-28T00:00:00+2:00",
  "2026-08-28T00:00:00+02:0",
  "2026-08-28T00:00:00+0200",
  "2026-08-28T00:00:00Z+01:00",
  "2026-08-28T00:00:00+02:00Z",
  "2026-08-28T00:00:00",
  "2026-08-28T00:00:00z",
  // Time-field bounds.
  "2026-08-28T24:00:00Z",
  "2026-08-28T23:60:00Z",
  "2026-08-28T23:59:60Z",
  "2026-08-28T99:99:99Z",
  // Calendar.
  "2026-02-30T00:00:00Z",
  "2026-02-29T00:00:00Z",
  "2026-04-31T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-00-10T00:00:00Z",
  "2026-01-00T00:00:00Z",
  "2026-1-01T00:00:00Z",
  // Shape.
  "not-a-time",
  "",
  " 2026-08-28T00:00:00Z",
  "2026-08-28T00:00:00Z ",
  "2026-08-28 00:00:00Z",
];

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

    // REVIEW ROUND 1, FINDING B3 (MEDIUM). The row above pins the INNER read
    // (`context.publishedWindowSeconds`) and left the OUTER one exposed:
    // reverting `ownField(input, "reviewContext")` to `input.reviewContext`
    // kept the suite green while `Object.prototype.reviewContext =
    // {publishedWindowSeconds:[30]}` moved a verified 30s TWAP spec from
    // SPEC_VERIFICATION_UNSOUND to REVIEWED_MODEL_BACKED / allowed:true. A
    // caller that states no feed context has stated none: "we do not know" may
    // not read as "it is fine" (the rule this function's own header states).
    it("an inherited `reviewContext` cannot supply a context the caller never stated (B3)", () => {
      const spec = verifiedSpec(twapSpecSample());
      for (const [variant, pollute] of [
        ["non-enumerable", withInherited],
        ["enumerable", withInheritedEnumerable],
      ] as const) {
        const verdict = pollute([["reviewContext", { publishedWindowSeconds: [30] }]], () =>
          classifySettlementActivation({ spec }),
        );
        expect(verdict.status, variant).toBe("SPEC_VERIFICATION_UNSOUND");
        expect(verdict.modelDependentActivationAllowed, variant).toBe(false);
        expect(verdict.refusals.map((refusal) => refusal.code), variant).toContain(
          "SETTLEMENT_PUBLISHED_WINDOWS_UNKNOWN",
        );
      }
      // …and a context the caller DOES state is still honoured.
      expect(
        classifySettlementActivation({ spec, reviewContext: publishedWindows }).status,
      ).toBe("REVIEWED_MODEL_BACKED");
    });

    // REVIEW ROUND 1, FINDING N1 (LOW). `settlementSpecReviewBlockers` is a
    // public `index.ts` export and takes a CALLER-SUPPLIED spec, which need not
    // be this door's prototype-free emission. The existing row above passes the
    // door's own output, so a dot read survives it — a null-prototype object
    // has no chain to answer from. This one hands the function an ORDINARY
    // object, which is what an external caller has.
    it("the review blockers read a caller-built spec's own fields (N1)", () => {
      const callerBuilt = without(
        verifiedSpec(terminalSpotSpecSample()),
        "rulesVersionId",
      ) as unknown as SettlementSpec;
      expect(Object.getPrototypeOf(callerBuilt)).toBe(Object.prototype);
      for (const [variant, pollute] of [
        ["non-enumerable", withInherited],
        ["enumerable", withInheritedEnumerable],
      ] as const) {
        expect(
          pollute([["rulesVersionId", "01936f00-0000-7000-8000-00000000b001"]], () =>
            settlementSpecReviewBlockers(callerBuilt).map((blocker) => blocker.code),
          ),
          variant,
        ).toContain("SETTLEMENT_RULES_VERSION_REQUIRED");
      }
      // A caller-built spec that DOES name its rules version still passes.
      expect(
        settlementSpecReviewBlockers(
          verifiedSpec(terminalSpotSpecSample()),
        ).map((blocker) => blocker.code),
      ).toEqual([]);
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

    // THE PRESENCE HALF.
    //
    // CORRECTED IN REMEDIATION (round-1 record repair). This row previously
    // carried the claim that the `optin`/`optout` waiver (ADR-020 §1 class 5)
    // "does not reach `SettlementSpecSchema`, cold or warm", and pinned the
    // restatement on its own contract for that reason. THE CLAIM WAS AN
    // ARTIFACT OF A BROKEN PROBE: the harness installed the pollution, called
    // an ASYNC body, and deleted the pollution when the body returned its
    // PROMISE — that is, before the dynamic import and the cold parse ever ran.
    // With an async-correct harness the waiver DOES reach this schema: see the
    // end-to-end cold row below, where the raw schema accepts a spec with
    // `roundingRule` deleted and another with `verification` deleted.
    //
    // The contract-level assertion is kept anyway — it names WHICH key is
    // reported, which the end-to-end row cannot — but it is no longer the only
    // measurement, and it is no longer the justification.
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

    // REVIEW ROUND 1, FINDING B1 (HIGH). The restated `verifiedAt` grammar was
    // wrong in BOTH directions, and only a DIFFERENTIAL sweep catches both:
    //
    // - FAIL-OPEN, the reviewer's finding: the offset's hour and minute were
    //   unbounded, so under an inherited `skipChecks` the door admitted
    //   `"…+24:00"` (and `±99:99`, `+00:60`, `+00:99`, `+25:00`, `-00:60`,
    //   `+90:00`) and the spec activated REVIEWED_MODEL_BACKED / allowed:true.
    // - FAIL-CLOSED, found by this sweep: the schema's seconds are OPTIONAL and
    //   its years may be `0000`-`0099`, and the door refused
    //   `"2026-08-28T00:00Z"`, `"2026-08-28T00:00+02:00"`, `"0000-01-01T…"`,
    //   `"0050-06-15T…"` and `"0099-12-31T…"` in a CLEAN process — refusing a
    //   document the contract accepts.
    //
    // Measured at `e0fab62`: schema accepts 19 of 51, door admitted 14 clean
    // and 23 polluted. The assertion is EQUALITY, not "refuses the bad ones",
    // so a restatement can never again be looser OR stricter than the schema.
    it("the restated `verifiedAt` grammar equals the schema's, in both directions (B1)", () => {
      const disagreements: string[] = [];
      let schemaAccepts = 0;
      for (const stamp of ISO_INSTANT_CASES) {
        const spec = {
          ...asRecord(verifiedSpec(terminalSpotSpecSample())),
          verification: { status: "VERIFIED", verifiedBy: "reviewer", verifiedAt: stamp },
        };
        // The schema, clean, is the authority this door restates.
        const schema = SettlementSpecSchema.safeParse(spec).success;
        if (schema) schemaAccepts += 1;
        const clean = safeParseSettlementSpec(spec).ok;
        const polluted = withInherited([["skipChecks", true]], () =>
          safeParseSettlementSpec(spec).ok,
        );
        if (clean !== schema) disagreements.push(`clean ${JSON.stringify(stamp)}: ${String(clean)}`);
        if (polluted !== schema) {
          disagreements.push(`skipChecks ${JSON.stringify(stamp)}: ${String(polluted)}`);
        }
      }
      expect(disagreements).toEqual([]);
      // Non-vacuity: the corpus must contain both verdicts, or the equality
      // above would hold for a door that accepts (or refuses) everything.
      expect(schemaAccepts).toBeGreaterThan(0);
      expect(schemaAccepts).toBeLessThan(ISO_INSTANT_CASES.length);

      // …and the reviewer's end-to-end row, spelled out: the admitted offset
      // reached REVIEWED_MODEL_BACKED / allowed:true at `e0fab62`.
      const verdict = withInherited([["skipChecks", true]], () =>
        classifySettlementActivation({
          spec: {
            ...asRecord(verifiedSpec(terminalSpotSpecSample())),
            verification: {
              status: "VERIFIED",
              verifiedBy: "reviewer",
              verifiedAt: "2026-08-28T00:00:00+24:00",
            },
          },
        }),
      );
      expect(verdict.status).toBe("SPEC_INVALID");
      expect(verdict.modelDependentActivationAllowed).toBe(false);
    });

    // B1's LESSON, GENERALIZED. Three of the door's restatements are
    // RE-IMPLEMENTATIONS of a pattern (UUIDv7, the code string, the ISO
    // instant) and two are re-implementations of a bound (`z.int().positive()`,
    // `NonEmptyString`). B1 was one of them measured wrong in both directions,
    // so the same differential is run over all of them rather than trusting
    // that the others were written more carefully. The placeholder matcher
    // needs no row here: the door calls the SAME function the schema's
    // refinement calls.
    it("every re-implemented grammar equals the schema's, in both directions", () => {
      const sample = asRecord(verifiedSpec(terminalSpotSpecSample()));
      const cases: readonly (readonly [string, readonly unknown[], (value: unknown) => unknown])[] = [
        [
          "settlementSpecId",
          [
            "01936f00-0000-7000-8000-00000000c001",
            "01936F00-0000-7000-8000-00000000C001",
            // SETL-1's confirming pass left ONE residual here: two single-group
            // case-widening drifts of `UUID_V7_FORM` survived the corpus. SETL-2
            // MEASURED the gap at base `c2c0733` and it is SIX, not two — the
            // uppercase row above is uppercase in groups 1 AND 5 at once, so
            // widening either group alone still refuses it and only the
            // all-groups drift (the `i` flag) is killed. A drift is killed only
            // by a spelling that is uppercase in EXACTLY the widened group, so
            // the gap needs one row per group. These six are each schema-
            // REJECTED and each kills exactly one drift: group 1, group 2,
            // group 3's hex tail, the `[89ab]` variant nibble, group 4's tail,
            // group 5.
            "01936F00-0000-7000-8000-00000000c001",
            "01936f00-000A-7000-8000-00000000c001",
            "01936f00-0000-700A-8000-00000000c001",
            "01936f00-0000-7000-A000-00000000c001",
            "01936f00-0000-7000-8A00-00000000c001",
            "01936f00-0000-7000-8000-00000000C001",
            "01936f00-0000-4000-8000-00000000c001",
            "01936f00-0000-7000-c000-00000000c001",
            "01936f00-0000-7000-8000-00000000c00",
            "01936f00-0000-7000-8000-00000000c0011",
            "01936f00000070008000 00000000c001",
            "",
            "not-a-uuid",
            42,
            null,
          ],
          (value) => ({ ...sample, settlementSpecId: value }),
        ],
        [
          "referenceSymbol",
          [
            "btc.usd",
            "b",
            "B",
            "a".repeat(64),
            "a".repeat(65),
            "btc usd",
            "1btc",
            ".btc",
            "btc-usd_x:y",
            "btc/usd",
            "btcusd\n",
            "",
            "btc€usd",
            7,
          ],
          (value) => ({ ...sample, referenceSymbol: value }),
        ],
        [
          "specVersion",
          [1, 2, 0, -1, -3.5, 1.5, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, Number.NaN,
            Number.POSITIVE_INFINITY, "1", null],
          (value) => ({ ...sample, specVersion: value }),
        ],
        [
          "roundingRule",
          [
            "No rounding: the exact decimal observation is compared as published.",
            "abc",
            "ab",
            "",
            " padded rule ",
            "x".repeat(2000),
            "x".repeat(2001),
            7,
          ],
          (value) => ({ ...sample, roundingRule: value }),
        ],
        [
          "verifiedBy",
          ["reviewer", "r", "", "x".repeat(200), "x".repeat(201), 7, null],
          (value) => ({
            ...sample,
            verification: { status: "VERIFIED", verifiedBy: value, verifiedAt: "2026-08-28T00:00:00Z" },
          }),
        ],
      ];

      const disagreements: string[] = [];
      for (const [field, corpus, build] of cases) {
        let accepted = 0;
        for (const value of corpus) {
          const spec = build(value);
          const schema = SettlementSpecSchema.safeParse(spec).success;
          if (schema) accepted += 1;
          const clean = safeParseSettlementSpec(spec).ok;
          const polluted = withInherited([["skipChecks", true]], () =>
            safeParseSettlementSpec(spec).ok,
          );
          if (clean !== schema) {
            disagreements.push(`${field} clean ${JSON.stringify(value)}: ${String(clean)}`);
          }
          if (polluted !== schema) {
            disagreements.push(`${field} skipChecks ${JSON.stringify(value)}: ${String(polluted)}`);
          }
        }
        // Non-vacuity per field: the corpus must split, or equality is free.
        expect(accepted, `${field}: corpus accepts nothing`).toBeGreaterThan(0);
        expect(accepted, `${field}: corpus refuses nothing`).toBeLessThan(corpus.length);
      }
      expect(disagreements).toEqual([]);
    });

    // THE COLD PROCESS. Everything above pollutes a schema this file has
    // already warmed. A real process's FIRST parse can be the hostile one, and
    // two of ADR-020 §1's classes only exist there. `vi.resetModules()` plus a
    // dynamic import gives a genuinely cold module; the harness is
    // async-correct (the pollution outlives the awaited import — the bug that
    // produced round 1's wrong "the waiver does not reach this schema" claim).
    it("a COLD first parse: the required-key waiver reaches the schema and not the door", async () => {
      const waiver = [
        ["optin", "optional"],
        ["optout", "optional"],
      ] as const;

      for (const missing of ["roundingRule", "verification"] as const) {
        vi.resetModules();
        const measured = await withInheritedAsync(
          [
            ...waiver,
            [
              "verification",
              { status: "VERIFIED", verifiedBy: "attacker", verifiedAt: "2026-08-28T00:00:00Z" },
            ],
          ],
          async () => {
            const specModule = (await import("./spec.js")) as typeof SpecModule;
            const activationModule = (await import("./activation.js")) as typeof ActivationModule;
            const raw = without(terminalSpotSpecSample(), missing);
            return {
              // The library, cold and waived: this is what `base` answered,
              // because at base this call WAS `safeParseSettlementSpec`.
              schema: specModule.SettlementSpecSchema.safeParse(raw).success,
              door: specModule.safeParseSettlementSpec(raw).ok,
              verdict: activationModule.classifySettlementActivation({ spec: raw }),
            };
          },
        );
        // Non-vacuity: the waiver must actually be defeating the library here,
        // or this row proves nothing about the door.
        expect(measured.schema, `${missing}: the cold waiver no longer defeats the schema`).toBe(
          true,
        );
        expect(measured.door, missing).toBe(false);
        expect(measured.verdict.status, missing).toBe("SPEC_INVALID");
        expect(measured.verdict.modelDependentActivationAllowed, missing).toBe(false);
      }
    });

    // The FOURTH refusal-construction trigger, confirmed by measurement rather
    // than by report (review round 1 named it): a COLD discriminated union
    // whose `propValues` map is built while a truthy `status` is inherited
    // throws `TypeError: propValues[key].add is not a function` out of
    // `SettlementVerificationSchema` — and `status` is precisely the key an
    // attack on the verification cell sets. The door contains it.
    it("a COLD discriminated union under an inherited `status` refuses instead of throwing", async () => {
      for (const value of ["VERIFIED", true, 1]) {
        vi.resetModules();
        const measured = await withInheritedAsync([["status", value]], async () => {
          const specModule = (await import("./spec.js")) as typeof SpecModule;
          const honest = verifiedSpec(terminalSpotSpecSample());
          let schema: string;
          try {
            schema = specModule.SettlementSpecSchema.safeParse(honest).success
              ? "parsed"
              : "refused";
          } catch (error: unknown) {
            schema = `threw ${(error as Error).name}`;
          }
          let door: string;
          try {
            const parsed = specModule.safeParseSettlementSpec(honest);
            door = parsed.ok ? "parsed" : "refused";
          } catch (error: unknown) {
            door = `threw ${(error as Error).name}`;
          }
          return { schema, door };
        });
        // Non-vacuity: the library really does throw here.
        expect(measured.schema, `status=${String(value)}`).toBe("threw TypeError");
        // The door's contract holds: a verdict comes back, and it is not a throw.
        expect(measured.door, `status=${String(value)}`).toBe("refused");
      }
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
    // (The accessor row above is deliberately joined by the B2 row below: an
    // accessor ALONE does not exercise the guard that refuses it.)
    const withProtoKey = JSON.parse(
      `{"__proto__":{"polluted":true},${JSON.stringify(sample).slice(1)}`,
    ) as unknown;
    expect(safeParseSettlementSpec(withProtoKey).ok).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  // REVIEW ROUND 1, FINDING B2 (HIGH). The `Object.hasOwn(descriptor, "value")`
  // test in `spec-door.ts`'s `ownMember` is load-bearing and was UNPINNED:
  // relaxing that one token to `"value" in descriptor` kept all 543 tests green
  // while reopening the sharpest cell of the row.
  //
  // WHY the accessor row above does not reach it: with no inherited `value`,
  // an accessor descriptor's `.value` reads `undefined`, the member is copied
  // as absent, and the spec is refused for a MISSING key — the right verdict
  // for the wrong reason. The guard only does work when a `value` is inherited,
  // and then the mutant reads the PROTOTYPE's `value` as if the property were
  // data: an own-accessor `verification` plus
  // `Object.prototype.value = {status:"VERIFIED", …}` restores
  // REVIEWED_MODEL_BACKED / allowed:true.
  it("an own ACCESSOR whose `value` is inherited is refused, and never invoked (B2)", () => {
    const stolen = {
      status: "VERIFIED",
      verifiedBy: "attacker",
      verifiedAt: "2026-08-28T00:00:00Z",
    };
    for (const [variant, pollute] of [
      ["non-enumerable", withInherited],
      ["enumerable", withInheritedEnumerable],
    ] as const) {
      let invocations = 0;
      const hostile = asRecord(terminalSpotSpecSample());
      Object.defineProperty(hostile, "verification", {
        get: () => {
          invocations += 1;
          return { status: "UNVERIFIED" };
        },
        enumerable: true,
        configurable: true,
      });

      const parsed = pollute([["value", stolen]], () => safeParseSettlementSpec(hostile));
      expect(parsed.ok, variant).toBe(false);

      const verdict = pollute([["value", stolen]], () =>
        classifySettlementActivation({ spec: hostile, reviewContext: publishedWindows }),
      );
      expect(verdict.status, variant).toBe("SPEC_INVALID");
      expect(verdict.modelDependentActivationAllowed, variant).toBe(false);

      // A getter is code, and this door refuses it WITHOUT running it: a
      // property that answers differently on a second read cannot be a field of
      // a reviewed document.
      expect(invocations, `${variant}: the getter was invoked`).toBe(0);
    }

    // The same guard on a NON-verification field, so the row is about the
    // mechanism rather than about one cell.
    let ruleInvocations = 0;
    const hostileRule = asRecord(terminalSpotSpecSample());
    Object.defineProperty(hostileRule, "roundingRule", {
      get: () => {
        ruleInvocations += 1;
        return "Round half up.";
      },
      enumerable: true,
      configurable: true,
    });
    expect(
      withInherited([["value", "No rounding: the exact decimal is compared."]], () =>
        safeParseSettlementSpec(hostileRule).ok,
      ),
    ).toBe(false);
    expect(ruleInvocations).toBe(0);
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
