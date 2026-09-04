/**
 * THE MECHANISM, PART 5 — a COLD process's first door parse under ENUMERABLE
 * inherited data (review round 9, H-1).
 *
 * THE FINDING THIS PINS. `zod` builds an object schema's parse tables LAZILY:
 * on the FIRST parse it rebuilds the shape as an ordinary spread literal and
 * walks it with `for…in` to compute `propValues` and the discriminated-union
 * discriminator map. `for…in` on an ordinary object ENUMERATES inherited
 * enumerable names, so at the round-8 tip ONE enumerable data property —
 * `Object.prototype.zzUnrelated = 1`, a name no schema mentions — made the
 * process's FIRST `evaluateIntent(riskPolicy(), valid cancel)` refuse with
 * `RISK_INPUT_INVALID`: a TRAPPED CANCEL, §6 invariant 13. The reviewer
 * measured the order-dependence in both directions — one clean parse first and
 * the trap never fires — and this round measured worse: the half-computed lazy
 * is POISONED, so after one polluted first parse the copy refuses FOREVER,
 * clean or not.
 *
 * THE FIX THIS EXERCISES. `schema-arena.ts` now WARMS every copy at build time
 * (module load, clean by definition) and severs the rebuilt containers, so
 * there is no lazy structure left for a polluted first parse to build.
 *
 * WHY THIS FILE IS SEPARATE, AND WHAT "COLD" MEANS HERE. The scenario needs
 * the FIRST evaluation-input parse of the module graph to happen INSIDE the
 * polluted window. Vitest isolates test files in fresh workers by default, and
 * this file keeps its module scope parse-free for the evaluation-input door:
 * the ONLY parse before the polluted window is the policy fixture's (a schema
 * with no discriminated union, measured unaffected by this class — and warming
 * one door's copy warms no other's). Nothing here can PROVE the pool
 * configuration keeps isolating; the cold-BY-CONSTRUCTION variant that cannot
 * be defeated by configuration lives in `schema-arena.test.ts` (each
 * `prototypeFreeParser` call builds fresh lazies). The two together are the
 * round-9 acceptance: cold process, pollution BEFORE the first parse, a valid
 * CANCEL approved and a malformed one refused, byte-identical to clean.
 */
import { describe, expect, it } from "vitest";

import { evaluateIntent } from "../../../packages/risk/src/index.js";
import { cancelIntent, entryInput, riskPolicy } from "./fixtures.js";

// Module scope, BEFORE any pollution: the inputs and the policy. Building the
// policy parses it (one door), which is the reviewer's own probe shape —
// `evaluateIntent(riskPolicy(), …)` — with the argument evaluated first.
const POLICY = riskPolicy();
const CANCEL = (() => {
  const input = entryInput();
  input.intent = cancelIntent();
  return input;
})();
const MALFORMED = (() => {
  const input = entryInput();
  input.intent = cancelIntent();
  (input as unknown as Record<string, unknown>)["evaluatedAt"] = "definitely-not-a-timestamp";
  return input;
})();

describe("a cold first parse under enumerable inherited data (§6 invariant 13)", () => {
  it("approves the valid CANCEL and refuses the malformed one, byte-identical to clean", () => {
    // THE POLLUTED WINDOW OPENS BEFORE THE FIRST EVALUATION-INPUT PARSE.
    Object.defineProperty(Object.prototype, "zzUnrelated", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: 1,
    });
    let pollutedValid: string;
    let pollutedMalformed: string;
    try {
      // The first parse of the evaluation-input door in this worker.
      pollutedValid = JSON.stringify(evaluateIntent(POLICY, CANCEL));
      pollutedMalformed = JSON.stringify(evaluateIntent(POLICY, MALFORMED));
    } finally {
      delete (Object.prototype as Record<string, unknown>)["zzUnrelated"];
    }

    const cleanValid = JSON.stringify(evaluateIntent(POLICY, CANCEL));
    const cleanMalformed = JSON.stringify(evaluateIntent(POLICY, MALFORMED));

    // The cancel is APPROVED — not merely "the same": at the round-8 tip both
    // the polluted-first answer AND every answer after it were refusals (the
    // poisoned lazy), so identity alone would have passed vacuously.
    expect(pollutedValid).toContain('"approved":true');
    expect(cleanValid).toContain('"approved":true');
    expect(pollutedValid).toBe(cleanValid);

    // The malformed input is REFUSED under pollution exactly as it is clean.
    expect(pollutedMalformed).toContain('"approved":false');
    expect(pollutedMalformed).toContain("RISK_INPUT_INVALID");
    expect(pollutedMalformed).toBe(cleanMalformed);
  });
});
