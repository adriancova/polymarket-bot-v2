/**
 * `WP-170-FU1` remediation round 1 — review round 1's **HIGH 1**: the raw
 * `modelOutputs` parse must not be poisonable by a polluted COLD FIRST PARSE.
 *
 * WHY THIS IS ITS OWN FILE, and why moving these cases into
 * `schema-door.test.ts` would silently disarm them. The defect is a property of
 * the FIRST-EVER parse of `RawModelOutputsSchema` in a process: a `pick`
 * normalizes its shape lazily, that normalization walks the shape with an
 * enumeration that sees inherited enumerable names, and a half-built lazy stays
 * POISONED for the life of the process. Vitest gives each test FILE its own
 * worker and its own module registry, so this file is the dedicated worker the
 * measurement needs. In any file that has already parsed `modelOutputs` once,
 * the schema is warm and the whole class is invisible — which is exactly how
 * `4c1bcde` shipped with it.
 *
 * MEASURED, base `53e9f62` vs tip `4c1bcde` vs this remediation, ONE enumerable
 * `Object.prototype.zzUnrelated = 1` present at the first `modelOutputs` parse
 * and deleted afterwards:
 *
 * ```text
 *                          base 53e9f62   tip 4c1bcde   remediated
 *   parse 1  (polluted)    CONTAINED      CONTAINED     DECIDED
 *   parse 2  (polluted)    CONTAINED      CONTAINED     DECIDED
 *   parse 3  (CLEAN)       DECIDED        CONTAINED     DECIDED
 *   parse 4  (CLEAN)       DECIDED        CONTAINED     DECIDED
 *   no modelOutputs        DECIDED        DECIDED       DECIDED
 * ```
 *
 * Base RECOVERED once the pollution was gone; `4c1bcde` never did — every later
 * decision carrying `modelOutputs` was `RUNTIME.DECISION_INVALID` forever, from
 * one transient enumerable property. `schema-boundary.md` §1 D2 requires "every
 * lazy forced at module load", and this was the one schema in the package that
 * was neither arena'd nor warmed. It is warmed at module load now
 * (`parse-door.ts`), which is why the polluted rows read DECIDED rather than
 * base's CONTAINED: the D1 materialization this round added already closed the
 * separate availability defeat that made base contain a valid decision.
 *
 * THE MUTATION THIS KILLS: delete the `RawModelOutputsSchema.safeParse({
 * modelOutputs: {} })` warm-up line in `parse-door.ts`. Parses 3 and 4 below
 * then answer CONTAINED and this file fails.
 */

import { describe, expect, it } from "vitest";

import { RawModelOutputsSchema } from "../../../packages/strategy-runtime/src/parse-door.js";
import { makeHarness, makeInput, makeStrategy, SNAPSHOT_REF } from "./helpers.js";

const HONEST_DECISION_WITH_OUTPUTS = {
  decisionType: "hold",
  reasonCodes: ["TEST.HOLD"],
  featureSnapshotRef: SNAPSHOT_REF,
  intents: [],
  modelOutputs: { edge: "0.03", flag: true, none: null },
};

const HONEST_DECISION_WITHOUT_OUTPUTS = {
  decisionType: "hold",
  reasonCodes: ["TEST.HOLD"],
  featureSnapshotRef: SNAPSHOT_REF,
  intents: [],
};

/** One evaluation, reduced to a comparable string; a throw is a value too. */
function evaluateReturning(decision: unknown): string {
  try {
    const harness = makeHarness({
      strategy: makeStrategy({ onFeatures: () => decision as never }),
    });
    const outcome = harness.runtime.evaluate(makeInput("onFeatures"));
    const record = harness.sink.calls[0]?.record;
    return `${outcome.kind}/${String(record?.attribution)}/${JSON.stringify(
      (record?.decision as unknown as Record<string, unknown> | undefined)?.["modelOutputs"],
    )}`;
  } catch (cause) {
    return `ESCAPED ${(cause as Error).name}: ${String((cause as Error).message).slice(0, 90)}`;
  }
}

/** Applies ONE enumerable inherited data property and restores it afterwards. */
function pollute(name: string): () => void {
  const original = Object.getOwnPropertyDescriptor(Object.prototype, name);
  Object.defineProperty(Object.prototype, name, {
    value: 1,
    writable: true,
    configurable: true,
    enumerable: true,
  });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(Object.prototype, name);
    } else {
      Object.defineProperty(Object.prototype, name, original);
    }
  };
}

describe("the raw `modelOutputs` parse survives a polluted first parse (HIGH 1)", () => {
  it("REPRODUCED-THEN-FLIPPED: pollute → parse → parse → depollute → parse must DECIDE", () => {
    const DECIDED = 'DECIDED/STRATEGY/{"edge":"0.03","flag":true,"none":null}';

    const restore = pollute("zzUnrelated");
    let polluted1: string;
    let polluted2: string;
    try {
      // The FIRST-EVER `modelOutputs` parse of this worker happens here, under
      // pollution. At `4c1bcde` this threw inside `safeParse`
      //   Invalid element at key "zzUnrelated": expected a Zod schema
      // and poisoned the schema permanently.
      polluted1 = evaluateReturning(HONEST_DECISION_WITH_OUTPUTS);
      polluted2 = evaluateReturning(HONEST_DECISION_WITH_OUTPUTS);
    } finally {
      restore();
    }
    // No throw escapes either way (ADR-020 §6), and a fail-closed answer under
    // pollution would be permitted — what is NOT permitted is not recovering.
    expect(polluted1.startsWith("ESCAPED"), polluted1).toBe(false);
    expect(polluted2.startsWith("ESCAPED"), polluted2).toBe(false);

    // THE PROPERTY: the process is clean again, so an honest decision decides —
    // and the `modelOutputs` it returned is the one the record carries.
    expect(evaluateReturning(HONEST_DECISION_WITH_OUTPUTS)).toBe(DECIDED);
    expect(evaluateReturning(HONEST_DECISION_WITH_OUTPUTS)).toBe(DECIDED);

    // A decision WITHOUT `modelOutputs` never touched the poisoned schema and
    // decided at every SHA; asserted so the test above cannot be read as
    // "evaluation is broken in general".
    expect(evaluateReturning(HONEST_DECISION_WITHOUT_OUTPUTS)).toBe(
      "DECIDED/STRATEGY/undefined",
    );

    // The polluted rows, recorded rather than rounded: with the schema warmed
    // and the decision materialized, they are the clean answer too.
    expect(polluted1).toBe(DECIDED);
    expect(polluted2).toBe(DECIDED);
  });

  it("the schema itself answers rather than throwing, warm and polluted alike", () => {
    // The same property one level down, on the schema the runtime holds. This
    // is a WARM assertion by construction (the test above already parsed), and
    // it is here for the class the warm-up is FOR: `safeParse` must return a
    // verdict, never propagate a normalization throw.
    //
    // The probes are PROTOTYPE-FREE because that is what the door hands this
    // schema (`runtime.ts` builds it with `ownData`). An ORDINARY probe is
    // refused under an enumerable inherited name — the raw schema is a
    // `z.strictObject` and its unknown-key walk is `for…in`, which enumerates
    // the chain — and that fail-closed availability answer is the pre-existing
    // residual `parse-door.ts` states, not the class this file is about.
    const probe = (outputs: Record<string, unknown> | undefined): Record<string, unknown> =>
      Object.assign(Object.create(null) as Record<string, unknown>, {
        modelOutputs:
          outputs === undefined
            ? undefined
            : Object.assign(Object.create(null) as Record<string, unknown>, outputs),
      });

    for (const name of ["zzUnrelated", "shape", "propValues", "def", "checks"]) {
      const restore = pollute(name);
      try {
        expect(() => RawModelOutputsSchema.safeParse(probe({}))).not.toThrow();
        expect(
          RawModelOutputsSchema.safeParse(probe({ a: "1" })).success,
          `${name}: a valid record must stay valid`,
        ).toBe(true);
        expect(
          RawModelOutputsSchema.safeParse(probe({ a: 1 })).success,
          `${name}: a number must stay refused`,
        ).toBe(false);
      } finally {
        restore();
      }
    }
  });
});
