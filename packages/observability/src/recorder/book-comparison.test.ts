import { describe, expect, it } from "vitest";

import {
  canonicalDecimal,
  compareRecordedBooks,
  type RecordedFrameInput,
} from "./book-comparison.js";

const ASSET_YES = "71321045679252212594626385532706912750332728571942532289631379312455583992563";
const ASSET_NO = "52114319501245915516055106046884209969926127482827954674443846427813813222426";
const MARKET = "0xbd31dc8a20211944f6b70f31557f1001557b59905b7738480ca09bd4532f84af";

function frame(ingestSeq: string, payload: unknown): RecordedFrameInput {
  return { ingestSeq, payloadUtf8: JSON.stringify(payload) };
}

function book(
  assetId: string,
  bids: [string, string][],
  asks: [string, string][],
): Record<string, unknown> {
  return {
    event_type: "book",
    market: MARKET,
    asset_id: assetId,
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    timestamp: "1756500000000",
    hash: "abc123",
  };
}

function priceChange(
  changes: { assetId: string; price: string; size: string; side: "BUY" | "SELL" }[],
): Record<string, unknown> {
  return {
    event_type: "price_change",
    market: MARKET,
    price_changes: changes.map((change) => ({
      asset_id: change.assetId,
      price: change.price,
      size: change.size,
      side: change.side,
    })),
    timestamp: "1756500000500",
  };
}

describe("canonicalDecimal", () => {
  it.each([
    ["0.50", "0.5"],
    ["0.500", "0.5"],
    ["00.5", "0.5"],
    ["0", "0"],
    ["0.0", "0"],
    ["000", "0"],
    ["10", "10"],
    ["10.010", "10.01"],
    ["1.", null],
    [".5", null],
    ["-1", null],
    ["1e3", null],
    ["", null],
    ["1,5", null],
  ])("canonicalDecimal(%j) -> %j", (input, expected) => {
    expect(canonicalDecimal(input)).toBe(expected);
  });
});

describe("compareRecordedBooks", () => {
  it("verifies a snapshot the deltas reproduce exactly", () => {
    const report = compareRecordedBooks([
      frame("1", book(ASSET_YES, [["0.40", "100"]], [["0.60", "50"]])),
      frame("2", priceChange([{ assetId: ASSET_YES, price: "0.41", size: "25", side: "BUY" }])),
      frame("3", priceChange([{ assetId: ASSET_YES, price: "0.60", size: "0", side: "SELL" }])),
      // The venue's next authoritative snapshot must equal the reconstruction:
      // bids 0.40@100 + 0.41@25, asks empty. Sizes arrive in a different but
      // numerically equal spelling, which canonical comparison must absorb.
      frame(
        "4",
        book(
          ASSET_YES,
          [
            ["0.4", "100.0"],
            ["0.41", "25"],
          ],
          [],
        ),
      ),
    ]);
    expect(report.ok).toBe(true);
    expect(report.snapshotsVerified).toBe(1);
    expect(report.snapshotsDiverged).toBe(0);
    expect(report.baselinesEstablished).toBe(1);
    expect(report.deltasApplied).toBe(2);
    expect(report.findings).toEqual([]);
  });

  it("reports a divergence with per-side arithmetic and resets to the snapshot", () => {
    const report = compareRecordedBooks([
      frame("1", book(ASSET_YES, [["0.40", "100"]], [["0.60", "50"]])),
      // A delta the recording somehow missed would make the reconstruction
      // disagree with the next snapshot:
      frame("2", book(ASSET_YES, [["0.40", "90"]], [["0.60", "50"]])),
      // After the reset, agreement resumes:
      frame("3", book(ASSET_YES, [["0.40", "90"]], [["0.60", "50"]])),
    ]);
    expect(report.ok).toBe(false);
    expect(report.snapshotsDiverged).toBe(1);
    expect(report.snapshotsVerified).toBe(1);
    const divergence = report.findings.find((finding) => finding.check === "book-divergence");
    expect(divergence?.details["bidSizeMismatches"]).toBe(1);
    expect(divergence?.details["asksMissing"]).toBe(0);
    expect(divergence?.details["ingestSeq"]).toBe("2");
    expect(divergence?.details["baselineIngestSeq"]).toBe("1");
  });

  it("tracks assets independently, including within one multiplexed frame", () => {
    const report = compareRecordedBooks([
      frame("1", [
        book(ASSET_YES, [["0.40", "100"]], []),
        book(ASSET_NO, [["0.55", "10"]], []),
      ]),
      frame(
        "2",
        priceChange([
          { assetId: ASSET_YES, price: "0.40", size: "0", side: "BUY" },
          { assetId: ASSET_NO, price: "0.56", size: "5", side: "BUY" },
        ]),
      ),
      frame("3", book(ASSET_YES, [], [])),
      frame(
        "4",
        book(
          ASSET_NO,
          [
            ["0.55", "10"],
            ["0.56", "5"],
          ],
          [],
        ),
      ),
    ]);
    expect(report.ok).toBe(true);
    expect(report.assetsSeen).toBe(2);
    expect(report.snapshotsVerified).toBe(2);
  });

  it("a delta before any snapshot is an info finding, never applied blind", () => {
    const report = compareRecordedBooks([
      frame("1", priceChange([{ assetId: ASSET_YES, price: "0.40", size: "10", side: "BUY" }])),
    ]);
    expect(report.ok).toBe(true);
    expect(report.deltasApplied).toBe(0);
    expect(report.findings[0]?.check).toBe("book-delta-before-snapshot");
    expect(report.findings[0]?.severity).toBe("info");
  });

  it("zero-size snapshot levels are normalized away, matching delta-deletion semantics", () => {
    const report = compareRecordedBooks([
      frame("1", book(ASSET_YES, [["0.40", "100"]], [])),
      frame("2", priceChange([{ assetId: ASSET_YES, price: "0.40", size: "0", side: "BUY" }])),
      // venue lists the emptied level:
      frame("3", book(ASSET_YES, [["0.40", "0"]], [])),
    ]);
    expect(report.ok).toBe(true);
    expect(report.snapshotsVerified).toBe(1);
  });

  it("non-book events are skipped, not findings", () => {
    const report = compareRecordedBooks([
      frame("1", {
        event_type: "last_trade_price",
        market: MARKET,
        asset_id: ASSET_YES,
        price: "0.5",
        side: "BUY",
      }),
    ]);
    expect(report.ok).toBe(true);
    expect(report.eventsSkipped).toBe(1);
    expect(report.framesUsed).toBe(0);
    expect(report.framesSeen).toBe(1);
  });

  it("a non-JSON payload is a finding, never a throw", () => {
    const report = compareRecordedBooks([{ ingestSeq: "1", payloadUtf8: "not json{" }]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.check).toBe("book-frame-unparseable");
  });

  it("a malformed decimal is a grammar finding naming the value", () => {
    const report = compareRecordedBooks([
      frame("1", book(ASSET_YES, [["0.40", "1e3"]], [])),
    ]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.check).toBe("book-level-grammar");
    expect(report.findings[0]?.details["size"]).toBe("1e3");
  });

  it("a crossed reconstruction at comparison time is a warning finding", () => {
    const report = compareRecordedBooks([
      frame("1", book(ASSET_YES, [["0.40", "100"]], [["0.60", "50"]])),
      frame("2", priceChange([{ assetId: ASSET_YES, price: "0.70", size: "10", side: "BUY" }])),
      frame(
        "3",
        book(
          ASSET_YES,
          [
            ["0.40", "100"],
            ["0.70", "10"],
          ],
          [["0.60", "50"]],
        ),
      ),
    ]);
    const crossed = report.findings.find(
      (finding) => finding.check === "book-crossed-reconstruction",
    );
    expect(crossed?.severity).toBe("warning");
    expect(crossed?.details["bestBid"]).toBe("0.7");
    expect(crossed?.details["bestAsk"]).toBe("0.6");
    // The snapshot agreed with the reconstruction, so no divergence:
    expect(report.snapshotsDiverged).toBe(0);
  });

  it("an unknown side is a finding", () => {
    const report = compareRecordedBooks([
      frame("1", book(ASSET_YES, [], [])),
      frame("2", {
        event_type: "price_change",
        market: MARKET,
        price_changes: [{ asset_id: ASSET_YES, price: "0.4", size: "1", side: "HOLD" }],
      }),
    ]);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.message).toContain("HOLD");
  });
});
