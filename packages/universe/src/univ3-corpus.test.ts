/**
 * The honest-input digests for `UNIV-3`.
 *
 * `./univ3-corpus.ts` runs every honest operation this package exposes, in a
 * fixed order, and digests the answers twice. The VALUE digest is the one that
 * matters: it was measured against the REAL base code at `c2c0733` (the five
 * edited modules stashed, the new ones unreferenced) and against the tip, and it
 * is BYTE-IDENTICAL. A hardening round that moves an honest answer is a
 * behaviour change, not a door.
 *
 * The SHAPE digest did move, and every difference is one of the three disclosed
 * D4 classes below. It is asserted anyway, because "the representation changed
 * in ways nobody wrote down" is exactly what a later reviewer needs to catch.
 */

import { describe, expect, it } from "vitest";

import {
  corpusShapeDigest,
  corpusValueDigest,
  runHonestCorpus,
  type CorpusEntry,
} from "./univ3-corpus.js";

describe("honest inputs are unchanged by the state-side door", () => {
  const entries: readonly CorpusEntry[] = runHonestCorpus();

  it("runs the whole corpus, not a prefix of it", () => {
    // The corpus returns early if a setup step refuses, so the count is the
    // vacuity guard: a door that broke `registerSeries` would shorten it.
    expect(entries).toHaveLength(40);
    expect(entries.at(-1)?.label).toBe("marketLifecycleInputFromEnvelope");
    const verdicts = entries.filter(
      (entry) => typeof entry.value === "object" && entry.value !== null && "ok" in entry.value,
    );
    const refused = verdicts.filter((entry) => (entry.value as { ok: boolean }).ok === false);
    // Three deliberate refusals: an unchanged parameter set, a replayed event,
    // and an operator asserting a terminal outcome.
    expect(refused.map((entry) => entry.label)).toEqual([
      "recordMarketParameters (unchanged)",
      "applyMarketLifecycleEvent (replayed)",
      "recordObservedOutcomeState (terminal refused)",
    ]);
    expect(verdicts.length - refused.length).toBeGreaterThanOrEqual(18);
  });

  it("produces the VALUE digest measured at the real base c2c0733", () => {
    // MEASURED, not asserted: `git stash` of `./lifecycle.ts`, `./parameters.ts`,
    // `./registry.ts`, `./eligibility.ts` and `./registration-door.ts` at base,
    // this corpus run, and then the same run at the tip. Both: `c91c5c0c…`.
    expect(corpusValueDigest(entries)).toBe(
      "c91c5c0ccdb6d5ebd5a1496c8464820c2a99f7af09902c6b4bde08ca74ac19c2",
    );
  });

  it("produces the tip's SHAPE digest, whose every difference is a disclosed D4 class", () => {
    // Base `c2c0733`: `b04b8181132200fc01397e708238ae060f018cb0db666bdd40a814959b42e425`.
    // The three classes that moved it, each measured and each disclosed:
    //
    //   1. the recorded parameter snapshot, version, history and the emitted
    //      `TradingParametersChanged` payload are now null-prototype and frozen
    //      (`./parameters-door.ts` D4);
    //   2. every projection the registry stores, and every projection a fold
    //      BUILDS, is now null-prototype and frozen (`./state-door.ts` D4);
    //   3. the stored `lastEventOrder` and the list `clarificationsAfterOpen`
    //      returns are now frozen (D4 and `UNIV-1` r1 LOW-3).
    //
    // None of them changes a key, a key ORDER, or a value — which is precisely
    // what the VALUE digest above asserts.
    expect(corpusShapeDigest(entries)).toBe(
      "561f9a8110e6f1117daf00bf2dcf4e54000b6f6fd7e365566788ba722d374c18",
    );
  });

  it("is deterministic: a second run digests identically", () => {
    const again = runHonestCorpus();
    expect(corpusValueDigest(again)).toBe(corpusValueDigest(entries));
    expect(corpusShapeDigest(again)).toBe(corpusShapeDigest(entries));
  });

  it("the two digests are sensitive: a single changed field moves both", () => {
    // A digest nothing can move is not evidence.
    const mutated: readonly CorpusEntry[] = [
      ...entries.slice(0, -1),
      { label: entries.at(-1)?.label ?? "", value: { ok: true, value: { changed: true } } },
    ];
    expect(corpusValueDigest(mutated)).not.toBe(corpusValueDigest(entries));
    expect(corpusShapeDigest(mutated)).not.toBe(corpusShapeDigest(entries));
  });
});
