import { divDecimalExact } from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import { normalizeFullAccuracyValue, normalizeRtdsInstant, shiftInstant } from "./values.js";

function value(raw: unknown): string {
  const outcome = normalizeFullAccuracyValue(raw);
  if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
  return outcome.value;
}

describe("full_accuracy_value is scaled by 10^18, exactly", () => {
  it("reproduces the documented example", () => {
    // "full_accuracy_value": "65000500000000000000000" alongside a display
    // "value": 65000.5 — the two agree only under the E18 scale.
    expect(value("65000500000000000000000")).toBe("65000.5");
    expect(value("3200250000000000000000")).toBe("3200.25");
  });

  it("keeps digits a double would lose", () => {
    // 65000.500000000000000001 is not representable as an IEEE-754 double; the
    // exact path must not round it, and must not go anywhere near the floating
    // `value` field.
    expect(value("65000500000000000000001")).toBe("65000.500000000000000001");
    expect(Number("65000.500000000000000001")).toBe(65000.5);
  });

  it("agrees with the decimal package's exact division", () => {
    for (const raw of ["1", "999", "65000500000000000000000", "1000000000000000000"]) {
      expect(value(raw)).toBe(divDecimalExact(raw, "1000000000000000000"));
    }
  });

  it("scales the smallest and largest documented-shaped magnitudes", () => {
    expect(value("1")).toBe("0.000000000000000001");
    expect(value("0")).toBe("0");
    expect(value("1000000000000000000")).toBe("1");
  });

  it("normalizes a non-canonical spelling before scaling", () => {
    expect(value("+065000500000000000000000")).toBe("65000.5");
  });
});

describe("full_accuracy_value refusals are typed values, never throws", () => {
  it("refuses a JSON number, because a double cannot carry the exact integer", () => {
    const outcome = normalizeFullAccuracyValue(65000500000000000000000);
    expect(outcome.status).toBe("invalid");
    expect(outcome.status === "invalid" ? outcome.reason : "").toContain("must be a string");
  });

  it("refuses absence rather than falling back to the display value", () => {
    for (const raw of [undefined, null, ""]) {
      const outcome = normalizeFullAccuracyValue(raw);
      expect(outcome.status).toBe("invalid");
      expect(outcome.status === "invalid" ? outcome.reason : "").toContain("required");
    }
  });

  it("refuses a non-integer, scientific notation, and junk", () => {
    for (const raw of ["65000.5", "6.5e22", "NaN", "Infinity", " 1 ", "0x10"]) {
      expect(normalizeFullAccuracyValue(raw).status).toBe("invalid");
    }
  });

  it("refuses an integer whose exact quotient cannot be represented", () => {
    // Defence in depth: dividing by a power of ten always terminates, so this
    // is reachable only for an absurdly long input. It must still be a value.
    const outcome = normalizeFullAccuracyValue("9".repeat(1000));
    expect(outcome.status).toBe("invalid");
  });

  it("scales a negative value faithfully rather than clamping it", () => {
    // "the exact SIGNED E18 fixed-point value". The domain bound that rejects a
    // negative TWAP is applied one layer up, with the raw value attached.
    expect(value("-65000500000000000000000")).toBe("-65000.5");
  });
});

describe("instants", () => {
  it("reads the documented epoch-millisecond form", () => {
    const outcome = normalizeRtdsInstant(1785178800000);
    expect(outcome).toEqual({
      status: "ok",
      value: { iso: "2026-07-27T19:00:00.000Z", epochMs: 1785178800000 },
    });
  });

  it("round-trips the ISO form back to the same milliseconds", () => {
    const outcome = normalizeRtdsInstant("1785178800123");
    expect(outcome.status === "ok" ? outcome.value.epochMs : 0).toBe(1785178800123);
  });

  it("reports an absent or unusable instant instead of substituting one", () => {
    expect(normalizeRtdsInstant(undefined).status).toBe("absent");
    expect(normalizeRtdsInstant(null).status).toBe("absent");
    expect(normalizeRtdsInstant("not a date").status).toBe("invalid");
    expect(normalizeRtdsInstant(1.5).status).toBe("invalid");
  });

  it("shifts an instant back by a whole lookback window", () => {
    const shifted = shiftInstant(1785178800000, -30_000);
    expect(shifted).toEqual({
      status: "ok",
      value: { iso: "2026-07-27T18:59:30.000Z", epochMs: 1785178770000 },
    });
  });

  it("refuses a shift that leaves the representable range", () => {
    expect(shiftInstant(0, -1e16).status).toBe("invalid");
  });
});
