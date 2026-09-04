/**
 * The fail-closed reader of the order-book v1 canonical serialization.
 *
 * The texts here are HAND-WRITTEN with hand-computed summary lines — they are
 * the oracle for the reader. The binding to the real `serializeBook` writer
 * lives in `test/unit/features/book-crosscheck.test.ts`, which drives live
 * `OutcomeTokenBook` instances.
 */

import { describe, expect, it } from "vitest";

import { SUPPORTED_BOOK_SERIALIZATION_VERSION, readBookSerialization } from "./book-serialization.js";

const MARKET = "018f4d2e-0000-7000-8000-000000000001";
const TOKEN = "123456";
const EPOCH = "018f4d2e-0000-7000-8000-0000000000aa";

const VALID_LINES = [
  "polymarket-bot/order-book/v1",
  `market ${MARKET}`,
  `token ${TOKEN}`,
  `epoch ${EPOCH}`,
  "generation 3",
  "lastIngestSeq 42",
  "venueBookHash abc123",
  "tickSize 0.01",
  "bestBid 0.48 100",
  "bestAsk 0.52 80",
  "spread 0.04",
  "depth bids 3 350 asks 2 200",
  "bids 3",
  "0.48 100",
  "0.47 50",
  "0.45 200",
  "asks 2",
  "0.52 80",
  "0.53 120",
];

function withLine(index: number, line: string): string {
  const lines = [...VALID_LINES];
  lines[index] = line;
  return lines.join("\n");
}

describe("readBookSerialization", () => {
  it("reads a valid serialization completely", () => {
    const read = readBookSerialization(VALID_LINES.join("\n"));
    expect(read).toEqual({
      ok: true,
      book: {
        internalMarketId: MARKET,
        tokenId: TOKEN,
        gatewayEpoch: EPOCH,
        subscriptionGeneration: 3,
        lastIngestSeq: "42",
        venueBookHash: "abc123",
        tickSize: "0.01",
        bids: [
          { price: "0.48", size: "100" },
          { price: "0.47", size: "50" },
          { price: "0.45", size: "200" },
        ],
        asks: [
          { price: "0.52", size: "80" },
          { price: "0.53", size: "120" },
        ],
      },
    });
  });

  it("reads an empty-sided book (absent best/spread markers) — absent, never zero", () => {
    const text = [
      "polymarket-bot/order-book/v1",
      `market ${MARKET}`,
      `token ${TOKEN}`,
      `epoch ${EPOCH}`,
      "generation 1",
      "lastIngestSeq 7",
      "venueBookHash -",
      "tickSize -",
      "bestBid - -",
      "bestAsk 0.52 80",
      "spread -",
      "depth bids 0 0 asks 1 80",
      "bids 0",
      "asks 1",
      "0.52 80",
    ].join("\n");
    const read = readBookSerialization(text);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.book.bids).toEqual([]);
    expect(read.book.venueBookHash).toBeUndefined();
    expect(read.book.tickSize).toBeUndefined();
  });

  it("refuses an unknown version line, and the constant matches the WP-150 format id", () => {
    expect(SUPPORTED_BOOK_SERIALIZATION_VERSION).toBe("polymarket-bot/order-book/v1");
    const read = readBookSerialization(withLine(0, "polymarket-bot/order-book/v2"));
    expect(read).toMatchObject({ ok: false, kind: "UNSUPPORTED_VERSION" });
  });

  it("refuses an unbaselined book (§7.1: no snapshot, no state)", () => {
    let text = withLine(3, "epoch -");
    text = text.replace("generation 3", "generation -").replace("lastIngestSeq 42", "lastIngestSeq -");
    const read = readBookSerialization(text);
    expect(read).toMatchObject({ ok: false, kind: "NOT_BASELINED" });
  });

  it("refuses a partially-absent baseline as inconsistent", () => {
    const read = readBookSerialization(withLine(3, "epoch -"));
    expect(read).toMatchObject({ ok: false, kind: "INCONSISTENT" });
  });

  const malformedCases: [string, string][] = [
    ["non-canonical epoch (uppercase)", withLine(3, `epoch ${EPOCH.toUpperCase()}`)],
    ["generation with leading zero", withLine(4, "generation 03")],
    ["negative lastIngestSeq", withLine(5, "lastIngestSeq -1")],
    ["tick size zero", withLine(7, "tickSize 0")],
    ["non-canonical tick size", withLine(7, "tickSize 0.010")],
    ["bad bids count", withLine(12, "bids x")],
    ["level with three fields", withLine(13, "0.48 100 extra")],
    ["non-canonical level price", withLine(13, "0.480 100")],
    ["price above one", withLine(13, "1.5 100")],
    ["negative price", withLine(13, "-0.48 100")],
    ["zero size level", withLine(13, "0.48 0")],
    ["negative size", withLine(13, "0.48 -5")],
    ["bids not strictly descending", withLine(14, "0.49 50")],
    ["duplicate bid price", withLine(14, "0.48 50")],
    ["asks not strictly ascending", withLine(18, "0.51 120")],
    ["trailing content", `${VALID_LINES.join("\n")}\nextra`],
    ["truncated ladder", VALID_LINES.slice(0, -1).join("\n")],
    ["missing market prefix", withLine(1, `mkt ${MARKET}`)],
  ];
  for (const [name, text] of malformedCases) {
    it(`refuses: ${name}`, () => {
      const read = readBookSerialization(text);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(["MALFORMED", "INCONSISTENT"]).toContain(read.kind);
    });
  }

  const inconsistentCases: [string, string][] = [
    ["bestBid disagreeing with the ladder", withLine(8, "bestBid 0.47 50")],
    ["bestBid size disagreeing", withLine(8, "bestBid 0.48 999")],
    ["bestAsk disagreeing", withLine(9, "bestAsk 0.53 120")],
    ["spread disagreeing", withLine(10, "spread 0.05")],
    ["depth count disagreeing", withLine(11, "depth bids 2 350 asks 2 200")],
    ["depth shares disagreeing", withLine(11, "depth bids 3 351 asks 2 200")],
  ];
  for (const [name, text] of inconsistentCases) {
    it(`refuses as INCONSISTENT: ${name}`, () => {
      const read = readBookSerialization(text);
      expect(read).toMatchObject({ ok: false, kind: "INCONSISTENT" });
    });
  }

  it("accepts a crossed book faithfully (order-book semantics: not this reader's judgment)", () => {
    const text = [
      "polymarket-bot/order-book/v1",
      `market ${MARKET}`,
      `token ${TOKEN}`,
      `epoch ${EPOCH}`,
      "generation 1",
      "lastIngestSeq 9",
      "venueBookHash -",
      "tickSize -",
      "bestBid 0.55 10",
      "bestAsk 0.52 80",
      "spread -0.03",
      "depth bids 1 10 asks 1 80",
      "bids 1",
      "0.55 10",
      "asks 1",
      "0.52 80",
    ].join("\n");
    const read = readBookSerialization(text);
    expect(read.ok).toBe(true);
  });
});
