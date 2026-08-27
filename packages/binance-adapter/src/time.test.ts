import { IsoTimestampSchema, UnsignedBigIntStringSchema } from "@polymarket-bot/domain";
import { describe, expect, it } from "vitest";

import { BinanceTimestampError } from "./errors.js";
import { elapsedMsBetween, systemClock, venueEpochToIso, venueToReceiptLagMs } from "./time.js";

describe("venueEpochToIso", () => {
  it("converts the documented millisecond example", () => {
    // `<symbol>@trade` documents `"T": 1672515782136`.
    expect(venueEpochToIso(1_672_515_782_136, "MILLISECOND")).toBe("2022-12-31T19:43:02.136Z");
  });

  it("produces a value the frozen envelope schema accepts", () => {
    const iso = venueEpochToIso(1_672_515_782_136, "MILLISECOND");
    expect(IsoTimestampSchema.safeParse(iso).success).toBe(true);
  });

  it("keeps all six fractional digits when the connection asked for microseconds", () => {
    // The same instant expressed in the unit `timeUnit=MICROSECOND` selects,
    // plus 789 microseconds that a millisecond rendering would have discarded.
    const iso = venueEpochToIso(1_672_515_782_136_789, "MICROSECOND");
    expect(iso).toBe("2022-12-31T19:43:02.136789Z");
    expect(IsoTimestampSchema.safeParse(iso).success).toBe(true);
  });

  it("pads a sub-millisecond microsecond remainder", () => {
    expect(venueEpochToIso(1_672_515_782_136_007, "MICROSECOND")).toBe(
      "2022-12-31T19:43:02.136007Z",
    );
  });

  it("reads the same number differently under the two units, which is why the unit is explicit", () => {
    expect(venueEpochToIso(1_672_515_782_136, "MILLISECOND")).toBe("2022-12-31T19:43:02.136Z");
    expect(venueEpochToIso(1_672_515_782_136, "MICROSECOND")).toBe("1970-01-20T08:35:15.782136Z");
  });

  it("rejects a value JSON could only represent approximately (BNC-U6)", () => {
    expect(() => venueEpochToIso(Number.MAX_SAFE_INTEGER + 2, "MILLISECOND")).toThrow(
      BinanceTimestampError,
    );
  });

  it("rejects a negative epoch rather than inventing an instant", () => {
    expect(() => venueEpochToIso(-1, "MILLISECOND")).toThrow(BinanceTimestampError);
  });

  it("rejects a value outside the representable instant range", () => {
    expect(() => venueEpochToIso(9_000_000_000_000_000, "MILLISECOND")).toThrow(
      BinanceTimestampError,
    );
  });
});

describe("elapsedMsBetween", () => {
  const at = (ns: string): { receivedAt: string; receivedMonotonicNs: string } => ({
    receivedAt: "2026-08-27T00:00:00.000Z",
    receivedMonotonicNs: ns,
  });

  it("measures elapsed time on the monotonic clock", () => {
    expect(elapsedMsBetween(at("1000000000"), at("1500000000"))).toBe(500);
  });

  it("truncates rather than rounding, because it reports an age", () => {
    expect(elapsedMsBetween(at("0"), at("1999999"))).toBe(1);
  });

  it("clamps a backwards pair at zero instead of reporting a negative age", () => {
    expect(elapsedMsBetween(at("2000000000"), at("1000000000"))).toBe(0);
  });

  it("handles readings far above Number.MAX_SAFE_INTEGER nanoseconds", () => {
    const huge = 9_007_199_254_740_993_000n;
    expect(
      elapsedMsBetween(at(huge.toString()), at((huge + 3_000_000n).toString())),
    ).toBe(3);
  });

  it("refuses a non-canonical monotonic string", () => {
    expect(() => elapsedMsBetween(at("007"), at("10"))).toThrow(BinanceTimestampError);
  });
});

describe("venueToReceiptLagMs", () => {
  it("is positive when the frame arrived after the venue stamped it", () => {
    expect(
      venueToReceiptLagMs("2026-08-27T00:00:00.000Z", "2026-08-27T00:00:00.250Z"),
    ).toBe(250);
  });

  it("keeps a negative sign, because host/venue clock skew is real evidence", () => {
    expect(
      venueToReceiptLagMs("2026-08-27T00:00:00.500Z", "2026-08-27T00:00:00.000Z"),
    ).toBe(-500);
  });

  it("throws on an unparseable instant instead of returning NaN", () => {
    expect(() => venueToReceiptLagMs("not-a-time", "2026-08-27T00:00:00.000Z")).toThrow(
      BinanceTimestampError,
    );
  });
});

describe("systemClock", () => {
  it("produces stamps the frozen envelope field schemas accept", () => {
    const stamp = systemClock.stamp();
    expect(IsoTimestampSchema.safeParse(stamp.receivedAt).success).toBe(true);
    expect(UnsignedBigIntStringSchema.safeParse(stamp.receivedMonotonicNs).success).toBe(true);
  });

  it("never moves its monotonic reading backwards", () => {
    const first = systemClock.stamp();
    const second = systemClock.stamp();
    expect(BigInt(second.receivedMonotonicNs)).toBeGreaterThanOrEqual(
      BigInt(first.receivedMonotonicNs),
    );
  });
});
