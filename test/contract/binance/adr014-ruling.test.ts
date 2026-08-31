/**
 * Mutation-probe coverage for the ADR-014 §3 parser (FU1 remediation round 1,
 * finding M1).
 *
 * THE DEFECT THIS PINS. Review round 1 showed that the previous parser — a
 * whole-document search for the first `m = true → …` string — kept the
 * conformance suite green when the real §3 row was reworded, or even when only
 * its whitespace changed, because ADR-014 repeats the mapping wording in §7's
 * verdict table and follow-up list and the search fell through to those
 * duplicates. The probes below are the reviewer's, made permanent.
 *
 * HOW THE MUTANTS ARE BUILT. Every mutated document is a COPY of the ruling
 * text assembled IN MEMORY. The real ADR on disk is read, never written, and
 * no altered copy of it is committed anywhere as a fixture. Where the shape
 * itself is under test, the document is SYNTHETIC — built from labelled
 * template lines that never claim to be ADR-014 or a ruling.
 *
 * OFFLINE. One file is read: the ADR. No socket, no clock, no configuration,
 * and no adapter code — this suite tests the parser, `taker-side.test.ts`
 * tests the adapter through it.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  Adr014ParseError,
  binanceRowOf,
  ruledSideForBinanceFlagIn,
  section3Of,
} from "./adr014-ruling.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADR_014 = readFileSync(
  resolve(HERE, "../../../docs/adr/ADR-014-taker-side-names-the-aggressor-order-side.md"),
  "utf8",
);

/**
 * The round-1 parser's pattern, verbatim: first `` `m = true → <side>` `` in
 * the WHOLE document. Kept here as the yardstick each probe is measured
 * against — a probe is only meaningful where this old pattern still matches
 * (i.e. where the old suite would have stayed green).
 */
function round1WholeDocumentSide(adr: string, buyerIsMaker: boolean): string | undefined {
  const pattern = new RegExp(String.raw`\x60m = ${String(buyerIsMaker)} → (BID|ASK)\x60`, "u");
  return pattern.exec(adr)?.[1];
}

/** The real §3 row, located by the parser under test. */
const REAL_ROW = binanceRowOf(section3Of(ADR_014));

/** The ruling text with the §3 row's line removed and nothing else changed. */
function withoutRealRow(adr: string): string {
  const lines = adr.split("\n");
  const remaining = lines.filter((line) => line !== REAL_ROW);
  if (remaining.length !== lines.length - 1) {
    throw new Error("expected exactly one line equal to the §3 row; the probe is not set up");
  }
  return remaining.join("\n");
}

describe("the real ruling on disk", () => {
  it("parses §3's Binance row: m = true → ASK, m = false → BID", () => {
    // Concrete values on purpose: this suite tests the PARSER, so the accepted
    // document's known content is the expected output. The conformance suite
    // (`taker-side.test.ts`) is the one that cross-checks the row against §1's
    // biconditional instead of hard-coding it.
    expect(ruledSideForBinanceFlagIn(ADR_014, true)).toBe("ASK");
    expect(ruledSideForBinanceFlagIn(ADR_014, false)).toBe("BID");
  });

  it("still contains the wording OUTSIDE §3 that made whole-document search unsafe", () => {
    // M1's precondition, pinned so the probes below stay meaningful: ADR-014's
    // §7 verdict table and follow-up list repeat the mapping wording as
    // history. If a future (superseding) record ever removes the duplicates,
    // this fails loudly and the probe suite gets consciously revisited rather
    // than silently probing nothing.
    const outsideSection3 = ADR_014.replace(section3Of(ADR_014), "");
    expect(round1WholeDocumentSide(outsideSection3, true)).toBe("ASK");
  });
});

describe("reviewer probes, permanent (in-memory mutants of the real text)", () => {
  it("probe (a): rewording only the §3 row refuses loudly; round 1 stayed green", () => {
    const reworded = REAL_ROW.replace(/\x60m = true → ASK\x60/u, "\x60m=true means ASK\x60");
    expect(reworded).not.toBe(REAL_ROW);
    const mutant = ADR_014.replace(REAL_ROW, reworded);

    // The round-1 parser still finds the §7 duplicates, so the old suite
    // passed 13/13 against exactly this mutant. That is the defect.
    expect(round1WholeDocumentSide(mutant, true)).toBe("ASK");

    // The span-scoped parser refuses — for BOTH flags, because the one
    // normative row no longer states both arms.
    expect(() => ruledSideForBinanceFlagIn(mutant, true)).toThrow(Adr014ParseError);
    expect(() => ruledSideForBinanceFlagIn(mutant, false)).toThrow(Adr014ParseError);
  });

  it("probe (b): whitespace-only variation WITHIN the §3 row stays accepted", () => {
    const spaced = REAL_ROW.replace(/\x60m = true → ASK\x60/u, "\x60m =  true  →  ASK\x60").replace(
      /\x60m = false → BID\x60/u,
      "\x60m =  false →   BID\x60",
    );
    expect(spaced).not.toBe(REAL_ROW);
    const mutant = ADR_014.replace(REAL_ROW, spaced);

    // Round 1 "passed" this mutant too — but by reading the §7 duplicate, not
    // the row. The span-scoped parser reads the actual row, reformatted.
    expect(ruledSideForBinanceFlagIn(mutant, true)).toBe("ASK");
    expect(ruledSideForBinanceFlagIn(mutant, false)).toBe("BID");
  });

  it("removing the §3 row refuses loudly, although exact duplicates remain later", () => {
    const mutant = withoutRealRow(ADR_014);
    expect(round1WholeDocumentSide(mutant, true)).toBe("ASK"); // the duplicate, still there
    expect(() => ruledSideForBinanceFlagIn(mutant, true)).toThrow(Adr014ParseError);
    expect(() => ruledSideForBinanceFlagIn(mutant, false)).toThrow(Adr014ParseError);
  });

  it("moving the row outside §3 refuses loudly", () => {
    const mutant = `${withoutRealRow(ADR_014)}\n\n${REAL_ROW}\n`;
    expect(mutant).toContain(REAL_ROW); // the row exists — just not inside §3
    expect(() => ruledSideForBinanceFlagIn(mutant, true)).toThrow(Adr014ParseError);
    expect(() => ruledSideForBinanceFlagIn(mutant, false)).toThrow(Adr014ParseError);
  });
});

/** A well-formed synthetic row; the sides are deliberately the ruled ones. */
const SYNTHETIC_ROW = "| Binance `m` (synthetic) | `m = true → ASK`; `m = false → BID` |";

/** A document shaped like a ruling. SYNTHETIC: never claims to be ADR-014. */
function syntheticRuling({
  heading3 = ["### 3. Synthetic mapping section"],
  section3 = [SYNTHETIC_ROW],
  heading4 = ["### 4. Synthetic next section"],
  afterSection4 = ["Synthetic trailing text."],
}: {
  readonly heading3?: readonly string[];
  readonly section3?: readonly string[];
  readonly heading4?: readonly string[];
  readonly afterSection4?: readonly string[];
} = {}): string {
  return [
    "# SYNTHETIC parser-probe document — not ADR-014, not a ruling",
    "",
    ...heading3,
    "",
    ...section3,
    "",
    ...heading4,
    "",
    ...afterSection4,
    "",
  ].join("\n");
}

describe("parser mechanics, on synthetic controlled text", () => {
  it("reads the row it is given rather than assuming the answer", () => {
    // Inverted sides on purpose: a parser that hard-coded ASK/BID would fail
    // here, and a parser that read the document would return what it says.
    const inverted = syntheticRuling({
      section3: ["| Binance `m` (synthetic) | `m = true → BID`; `m = false → ASK` |"],
    });
    expect(ruledSideForBinanceFlagIn(inverted, true)).toBe("BID");
    expect(ruledSideForBinanceFlagIn(inverted, false)).toBe("ASK");
  });

  it("refuses a duplicated row INSIDE §3: no guessing which one is normative", () => {
    const doc = syntheticRuling({ section3: [SYNTHETIC_ROW, SYNTHETIC_ROW] });
    expect(() => ruledSideForBinanceFlagIn(doc, true)).toThrow(Adr014ParseError);
  });

  it("is not satisfied by a perfect row that exists only OUTSIDE §3", () => {
    const doc = syntheticRuling({
      section3: ["| a table with | no mapping row |"],
      afterSection4: ["Historical restatement:", SYNTHETIC_ROW],
    });
    expect(() => ruledSideForBinanceFlagIn(doc, true)).toThrow(Adr014ParseError);
    expect(() => ruledSideForBinanceFlagIn(doc, false)).toThrow(Adr014ParseError);
  });

  it("refuses a row that states one arm twice, for BOTH queries", () => {
    const doc = syntheticRuling({
      section3: ["| x | `m = true → ASK` or `m = true → BID`; `m = false → BID` |"],
    });
    expect(() => ruledSideForBinanceFlagIn(doc, true)).toThrow(Adr014ParseError);
    // The false arm alone is coherent, but half of a broken row is not read.
    expect(() => ruledSideForBinanceFlagIn(doc, false)).toThrow(Adr014ParseError);
  });

  it("refuses a document whose `### 3` heading is missing or duplicated", () => {
    expect(() => ruledSideForBinanceFlagIn(syntheticRuling({ heading3: [] }), true)).toThrow(
      Adr014ParseError,
    );
    const twoSectionThrees = syntheticRuling({
      afterSection4: ["### 3. A second synthetic mapping section"],
    });
    expect(() => ruledSideForBinanceFlagIn(twoSectionThrees, true)).toThrow(Adr014ParseError);
  });

  it("refuses a document whose `### 4` heading is missing or precedes `### 3`", () => {
    expect(() => ruledSideForBinanceFlagIn(syntheticRuling({ heading4: [] }), true)).toThrow(
      Adr014ParseError,
    );
    const reversed = [
      "# SYNTHETIC parser-probe document — not ADR-014, not a ruling",
      "",
      "### 4. Synthetic next section, too early",
      "",
      "### 3. Synthetic mapping section",
      "",
      SYNTHETIC_ROW,
      "",
    ].join("\n");
    expect(() => ruledSideForBinanceFlagIn(reversed, true)).toThrow(Adr014ParseError);
  });
});
