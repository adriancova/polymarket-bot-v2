/**
 * The settlement port is pinned here — against the settlement package's SOURCE.
 *
 * The round-1 review (H2, reviewer note) found the previous pin compared a
 * Universe constant with a hard-coded Universe list, so a Settlement-only
 * vocabulary change could not fail it. This version reads
 * `packages/settlement/src/activation.ts` AS TEXT and extracts the token list
 * from it, so a change on EITHER side fails this test.
 *
 * WHY A FILE READ AND NOT AN IMPORT: `packages/universe` and
 * `packages/settlement` are the same dependency layer, and
 * `docs/contracts/dependency-direction.md` §2.1 lists no edge between them —
 * an import (type-only included) or a `package.json` edge would be violation
 * F13. A TEST-ONLY read of the sibling source text creates no module edge and
 * no workspace dependency; the precedent is `seeds.test.ts`, this package's
 * only other test-time file access. If the settlement package moves its
 * activation module, this test fails loudly (file not found) rather than
 * silently pinning nothing.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ACTIVATION_PERMITTED_STATUS,
  SETTLEMENT_ACTIVATION_STATUSES,
  isConsistentSettlementActivation,
  permittedSettlementActivationProblems,
  type PermittedSettlementActivationView,
} from "./settlement-binding.js";
import { permittingSettlementView, unverifiedSettlementView } from "./testing/index.js";

const SETTLEMENT_ACTIVATION_SOURCE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../settlement/src/activation.ts",
);

/** The status tokens as the SETTLEMENT package's source declares them. */
function settlementSourceStatuses(): readonly string[] {
  const source = readFileSync(SETTLEMENT_ACTIVATION_SOURCE, "utf8");
  const block = /export const SETTLEMENT_ACTIVATION_STATUSES = \[([^\]]*)\] as const/u.exec(
    source,
  );
  if (block?.[1] === undefined) {
    throw new Error(
      `could not find SETTLEMENT_ACTIVATION_STATUSES in ${SETTLEMENT_ACTIVATION_SOURCE}`,
    );
  }
  return [...block[1].matchAll(/"([A-Z_]+)"/gu)].map((match) => match[1] as string);
}

/** The permitted status as the SETTLEMENT package's source declares it. */
function settlementSourcePermittedStatus(): string {
  const source = readFileSync(SETTLEMENT_ACTIVATION_SOURCE, "utf8");
  const match = /export const ACTIVATION_PERMITTED_STATUS[^=]*=\s*"([A-Z_]+)"/u.exec(source);
  if (match?.[1] === undefined) {
    throw new Error(
      `could not find ACTIVATION_PERMITTED_STATUS in ${SETTLEMENT_ACTIVATION_SOURCE}`,
    );
  }
  return match[1];
}

describe("settlement activation port", () => {
  it("pins the status vocabulary against the settlement package's source text", () => {
    expect([...SETTLEMENT_ACTIVATION_STATUSES]).toEqual(settlementSourceStatuses());
  });

  it("pins the permitted status against the settlement package's source text", () => {
    expect(ACTIVATION_PERMITTED_STATUS).toBe(settlementSourcePermittedStatus());
  });

  it("permits exactly one status", () => {
    expect(ACTIVATION_PERMITTED_STATUS).toBe("REVIEWED_MODEL_BACKED");
    expect(
      SETTLEMENT_ACTIVATION_STATUSES.filter((status) => status === ACTIVATION_PERMITTED_STATUS),
    ).toHaveLength(1);
  });

  it("accepts a self-consistent verdict", () => {
    expect(isConsistentSettlementActivation(permittingSettlementView())).toBe(true);
    expect(isConsistentSettlementActivation(unverifiedSettlementView())).toBe(true);
  });

  it("rejects a verdict whose flag and status disagree, in either direction", () => {
    expect(
      isConsistentSettlementActivation({
        ...permittingSettlementView(),
        modelDependentActivationAllowed: false,
      }),
    ).toBe(false);
    expect(
      isConsistentSettlementActivation({
        ...unverifiedSettlementView(),
        modelDependentActivationAllowed: true,
      }),
    ).toBe(false);
  });

  describe("permittedSettlementActivationProblems (round-1, H2)", () => {
    it("finds nothing wrong with a complete permission", () => {
      expect(permittedSettlementActivationProblems(permittingSettlementView())).toEqual([]);
    });

    it.each(["settlementSpecId", "seriesId", "rulesVersionId", "payoffModel"] as const)(
      "reports a missing or empty %s",
      (field) => {
        for (const value of [undefined, ""]) {
          const problems = permittedSettlementActivationProblems(
            permittingSettlementView({ [field]: value }),
          );
          expect(problems.map((problem) => problem.field)).toEqual([field]);
        }
      },
    );

    it("reports refusals that are missing or non-empty", () => {
      expect(
        permittedSettlementActivationProblems(
          permittingSettlementView({ refusals: undefined }),
        ).map((problem) => problem.field),
      ).toEqual(["refusals"]);
      expect(
        permittedSettlementActivationProblems(
          permittingSettlementView({
            refusals: [{ code: "SETTLEMENT_ANYTHING", message: "left over" }],
          }),
        ).map((problem) => problem.field),
      ).toEqual(["refusals"]);
    });
  });

  // Round-2 review, L1: `refusals` on the permitted arm is the empty tuple
  // type, so a permitted verdict carrying a refusal is a COMPILE error (the
  // reviewer's tsc probe compiled clean when it was `readonly
  // SettlementRefusalView[]`). If the type ever loosens again, the
  // `@ts-expect-error` below becomes "unused" and `tsc --noEmit` fails —
  // a negative compile-time test with no cross-package import.
  describe("permitted-arm refusals type (round-2, L1)", () => {
    it("rejects a permitted verdict carrying a refusal at compile time and at runtime", () => {
      const forged: PermittedSettlementActivationView = {
        status: "REVIEWED_MODEL_BACKED",
        modelDependentActivationAllowed: true,
        settlementSpecId: "01936f00-0000-7000-8000-00000000c001",
        seriesId: "01936f00-0000-7000-8000-00000000a001",
        rulesVersionId: "01936f00-0000-7000-8000-00000000b001",
        payoffModel: "ReferenceOpenUpDownModel",
        // @ts-expect-error -- round-2 L1: the permitted arm's refusals are typed `readonly []`; one refusal must not compile
        refusals: [{ code: "SETTLEMENT_ANYTHING", message: "left over" }],
      };
      // The runtime check refuses the same forgery independently of the type.
      expect(
        permittedSettlementActivationProblems(forged).map((problem) => problem.field),
      ).toEqual(["refusals"]);
    });

    it("accepts the honest empty refusal list at compile time", () => {
      const honest: PermittedSettlementActivationView = {
        status: "REVIEWED_MODEL_BACKED",
        modelDependentActivationAllowed: true,
        settlementSpecId: "01936f00-0000-7000-8000-00000000c001",
        seriesId: "01936f00-0000-7000-8000-00000000a001",
        rulesVersionId: "01936f00-0000-7000-8000-00000000b001",
        payoffModel: "ReferenceOpenUpDownModel",
        refusals: [],
      };
      expect(permittedSettlementActivationProblems(honest)).toEqual([]);
    });
  });
});
