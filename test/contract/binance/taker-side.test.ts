/**
 * ADR-014 conformance: what this adapter writes into `takerSide`.
 *
 * THE EXPECTATION IS READ OUT OF THE RULING, NOT RESTATED BESIDE IT. Every
 * assertion below derives its expected value from the text of
 * `docs/adr/ADR-014-taker-side-names-the-aggressor-order-side.md`, parsed from
 * disk at test time. A test that hard-coded `"ASK"` would prove only that the
 * adapter still does what it did when the test was written; this one fails if
 * the adapter stops matching the accepted record, and refuses to run at all if
 * the record's ruling text is not where it says it is.
 *
 * WHY IT IS A CONTRACT TEST. `BNC-U5` — "which book side does `takerSide` name?"
 * — was never a Binance question. It was a question about the frozen domain
 * contract's vocabulary, and it was answered by the contract owner. The check
 * therefore belongs where the adapter meets the contract: documented venue
 * frames in, frozen domain payloads out.
 *
 * OFFLINE. Two files are read: the ADR, and the fixtures. No socket, no clock,
 * no configuration.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as adapter from "@polymarket-bot/binance-adapter";
import {
  BinanceConfigurationError,
  BinanceReferenceFeed,
  takerSideFor,
  type AdapterEmission,
  type BinanceReferenceFeedOptions,
} from "@polymarket-bot/binance-adapter";
import { ReferenceTradeObservedPayloadSchema } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { frameText, framesFixture } from "./fixtures.js";
import { createHarness, deliver, open } from "./support.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADR_014 = readFileSync(
  resolve(HERE, "../../../docs/adr/ADR-014-taker-side-names-the-aggressor-order-side.md"),
  "utf8",
);

/**
 * §1's biconditional, read from the record: which side names a taker who was
 * buying, and which names a taker who was selling.
 *
 * The ADR states these as two bullets — "**`BID`** ⇔ **the taker was buying.**"
 * and "**`ASK`** ⇔ **the taker was selling.**" — and §2 exists precisely because
 * the opposite reading is available to a careless reader. Parsing them keeps the
 * careless reading out of this file too.
 */
function sideNamingATakerWhoWas(action: "buying" | "selling"): string {
  const pattern = new RegExp(
    String.raw`\*\*\x60(BID|ASK)\x60\*\*\s*⇔\s*\*\*the taker was ${action}\.\*\*`,
    "u",
  );
  const match = pattern.exec(ADR_014);
  const side = match?.[1];
  if (side === undefined) {
    throw new Error(
      `ADR-014 §1 no longer states which side names a taker who was ${action}; this test cannot be run against a ruling it cannot read`,
    );
  }
  return side;
}

/** §3's Binance row: the mapping the ADR derives from the documented `m`. */
function ruledSideForBinanceFlag(buyerIsMaker: boolean): string {
  const pattern = new RegExp(String.raw`\x60m = ${String(buyerIsMaker)} → (BID|ASK)\x60`, "u");
  const match = pattern.exec(ADR_014);
  const side = match?.[1];
  if (side === undefined) {
    throw new Error(
      `ADR-014 §3 no longer states a mapping for Binance's m = ${String(buyerIsMaker)}`,
    );
  }
  return side;
}

const DOCUMENTED_BUYER_IS_MAKER = framesFixture("trade-documented");
const SYNTHETIC_BUYER_IS_TAKER = framesFixture("trade-buyer-is-taker-synthetic");

/** Drives one fixture frame through a DEFAULT feed and returns the trade emission. */
function tradeEmissionFor(frame: { readonly json?: unknown; readonly text?: string }): AdapterEmission {
  // `createHarness()` passes no takerSide-related option, because none exists.
  const harness = createHarness();
  open(harness, "conn-taker-side");
  const outcome = deliver(harness, frameText(frame), harness.clock.advance(1));
  const emission = outcome.emissions.find(
    (candidate) => candidate.eventType === "ReferenceTradeObserved",
  );
  if (emission === undefined) {
    throw new Error("expected a ReferenceTradeObserved emission");
  }
  return emission;
}

function takerSideOf(emission: AdapterEmission): unknown {
  return (emission.payload as { takerSide?: unknown }).takerSide;
}

describe("the ruling this suite checks against", () => {
  it("is the accepted ADR-014, and states §1's biconditional", () => {
    expect(ADR_014).toContain("# ADR-014: `takerSide` names the aggressor order's own side");
    expect(ADR_014).toContain("- **Status:** Accepted");
    expect(sideNamingATakerWhoWas("buying")).toBe("BID");
    expect(sideNamingATakerWhoWas("selling")).toBe("ASK");
  });

  it("derives Binance's row consistently with that biconditional", () => {
    // §3's row says `m = true → ASK` and gives its reason: "the buyer was the
    // maker, so the taker was the **seller**". So the row's value for `m = true`
    // must be the side §1 gives a taker who was SELLING, and the row's value for
    // `m = false` the side it gives a taker who was BUYING. If the record ever
    // contradicts itself, this suite says so before it tests any code.
    expect(ruledSideForBinanceFlag(true)).toBe(sideNamingATakerWhoWas("selling"));
    expect(ruledSideForBinanceFlag(false)).toBe(sideNamingATakerWhoWas("buying"));
  });

  it("states that the consumed-book-side reading is NOT what the field means", () => {
    expect(ADR_014).toContain("### 2. It is NOT the side of the book that was consumed");
    // The rejected reading maps `m = true` to the opposite of the ruled value.
    expect(ruledSideForBinanceFlag(true)).not.toBe(sideNamingATakerWhoWas("buying"));
  });
});

describe("emitted `takerSide` conforms to ADR-014", () => {
  it("maps the documented `m: true` trade to the ruled side", () => {
    for (const frame of DOCUMENTED_BUYER_IS_MAKER.frames) {
      const emission = tradeEmissionFor(frame);
      expect(takerSideOf(emission), `${frame.label}`).toBe(ruledSideForBinanceFlag(true));
      // Said the other way round, from §1: the buyer was the maker, so the taker
      // was the seller, so the field names the side of a SELLING taker.
      expect(takerSideOf(emission)).toBe(sideNamingATakerWhoWas("selling"));
    }
  });

  it("maps an `m: false` trade to the opposite ruled side", () => {
    for (const frame of SYNTHETIC_BUYER_IS_TAKER.frames) {
      const emission = tradeEmissionFor(frame);
      expect(takerSideOf(emission), `${frame.label}`).toBe(ruledSideForBinanceFlag(false));
      expect(takerSideOf(emission)).toBe(sideNamingATakerWhoWas("buying"));
    }
  });

  it("emits the field on every trade, from a feed given no option about it", () => {
    // ADR-014's §7 follow-up item 3 left the default to this package and required
    // it to be stated: the mapping is the behavior, and it is unconditional.
    // Before the ruling this same default emitted the field ABSENT.
    const documented = DOCUMENTED_BUYER_IS_MAKER.frames[0];
    const synthetic = SYNTHETIC_BUYER_IS_TAKER.frames[0];
    if (documented === undefined || synthetic === undefined) {
      throw new Error("fixture frame missing");
    }
    for (const frame of [documented, synthetic]) {
      const emission = tradeEmissionFor(frame);
      expect("takerSide" in (emission.payload as object)).toBe(true);
      expect(takerSideOf(emission)).toMatch(/^(BID|ASK)$/u);
    }
  });

  it("produces a payload the frozen contract accepts, with the side included", () => {
    for (const frame of [
      ...DOCUMENTED_BUYER_IS_MAKER.frames,
      ...SYNTHETIC_BUYER_IS_TAKER.frames,
    ]) {
      const emission = tradeEmissionFor(frame);
      const parsed = ReferenceTradeObservedPayloadSchema.safeParse(emission.payload);
      expect(parsed.success, `${frame.label}`).toBe(true);
      if (parsed.success) {
        expect(parsed.data.takerSide).toBe(takerSideOf(emission));
      }
    }
  });

  it("distinguishes the two polarities: the two fixtures disagree", () => {
    // A mapping that returned a constant would satisfy one polarity's assertion
    // and this one catches it.
    const documented = DOCUMENTED_BUYER_IS_MAKER.frames[0];
    const synthetic = SYNTHETIC_BUYER_IS_TAKER.frames[0];
    if (documented === undefined || synthetic === undefined) {
      throw new Error("fixture frame missing");
    }
    expect(takerSideOf(tradeEmissionFor(documented))).not.toBe(
      takerSideOf(tradeEmissionFor(synthetic)),
    );
  });
});

describe("no convention is selectable any more (ADR-014 §7 follow-up item 2)", () => {
  it("exposes a total, unparameterised mapping on the package surface", () => {
    expect(takerSideFor.length).toBe(1);
    expect(takerSideFor(true)).toBe(ruledSideForBinanceFlag(true));
    expect(takerSideFor(false)).toBe(ruledSideForBinanceFlag(false));
  });

  it("ignores a convention argument rather than honouring one", () => {
    // THE MUTATION THIS CATCHES. A future editor restores the deleted
    // `BOOK_SIDE_CONSUMED` reading as an OPTIONAL second parameter defaulting to
    // the conforming one. `takerSideFor.length` would still be 1 — a defaulted
    // parameter does not count — and every "does it map correctly" assertion
    // would still pass, while the inverse-emitting path ADR-014 §4.3 calls "a
    // contract violation, not a configuration choice" was quietly back, one
    // argument away. So the extra argument is passed here on purpose.
    const loose = takerSideFor as unknown as (
      buyerIsMaker: boolean,
      ...rest: readonly unknown[]
    ) => unknown;
    for (const convention of ["BOOK_SIDE_CONSUMED", "TAKER_ORDER_DIRECTION", "OMIT"]) {
      expect(loose(true, convention), convention).toBe(ruledSideForBinanceFlag(true));
      expect(loose(false, convention), convention).toBe(ruledSideForBinanceFlag(false));
    }
  });

  it("exports nothing that names a takerSide convention", () => {
    // The removed `TAKER_SIDE_CONVENTIONS` / `TakerSideConvention` pair was part
    // of this package's public surface; a restoration that re-exported it would
    // be visible to consumers, so it is checked from a consumer's position.
    const exportNames = Object.keys(adapter);
    expect(exportNames.filter((name) => /convention/iu.test(name))).toEqual([]);
    expect(exportNames).toContain("takerSideFor");
  });

  it("refuses a feed constructed with the removed option, from a consumer's position", () => {
    // A caller assembling options from JSON reaches this even though the key is
    // no longer in the options type. Silently ignoring it would leave an
    // operator believing a `takerSide` convention is still in force.
    const withRemovedOption = {
      feedId: "binance.reference",
      subscriptions: [{ symbol: "BNBBTC", suffix: "trade" }],
      stalenessThresholdMs: 30_000,
      takerSideConvention: "BOOK_SIDE_CONSUMED",
    } as unknown as BinanceReferenceFeedOptions;

    expect(() => new BinanceReferenceFeed(withRemovedOption)).toThrow(BinanceConfigurationError);
    expect(() => new BinanceReferenceFeed(withRemovedOption)).toThrow(/ADR-014/u);
  });

  it("emits one side per `m` value, whoever built the feed", () => {
    const documented = DOCUMENTED_BUYER_IS_MAKER.frames[0];
    if (documented === undefined) {
      throw new Error("fixture frame missing");
    }
    const sides = [tradeEmissionFor(documented), tradeEmissionFor(documented)].map(takerSideOf);
    expect(sides).toEqual([ruledSideForBinanceFlag(true), ruledSideForBinanceFlag(true)]);
  });
});
