import { divDecimalExact } from "@polymarket-bot/decimal";
import { describe, expect, it } from "vitest";

import {
  normalizeFullAccuracyValue,
  normalizeRtdsObservationInstant,
  normalizeRtdsPublisherInstant,
  shiftInstant,
} from "./values.js";

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

describe("the Chainlink observation time is Unix epoch milliseconds, and only that", () => {
  it("reads the documented epoch-millisecond form", () => {
    const outcome = normalizeRtdsObservationInstant(1785178800000);
    expect(outcome).toEqual({
      status: "ok",
      value: { iso: "2026-07-27T19:00:00.000Z", epochMs: 1785178800000 },
    });
  });

  it("reads the all-digit spelling as the same milliseconds", () => {
    const outcome = normalizeRtdsObservationInstant("1785178800123");
    expect(outcome.status === "ok" ? outcome.value.epochMs : 0).toBe(1785178800123);
  });

  it("never applies the SDK's seconds-versus-milliseconds heuristic", () => {
    // Round-1 review finding M1, in its own probe: the generic epoch-like
    // parser reads a number below 1e12 as SECONDS, which turned 1234 into
    // 1970-01-01T00:20:34.000Z (epochMs 1234000). This field is documented as
    // unix ms by both the current page and the frozen report §10.3, so the
    // value is read literally — mis-scaling `windowEndAt` is not recoverable
    // downstream, and this is the field the window, the ordering and the
    // duplicate identity are all built on.
    for (const raw of [1, 1234, 999_999_999_999]) {
      const strict = normalizeRtdsObservationInstant(raw);
      expect(strict.status === "ok" ? strict.value.epochMs : -1).toBe(raw);
      const tolerant = normalizeRtdsPublisherInstant(raw);
      expect(tolerant.status === "ok" ? tolerant.value.epochMs : -1).toBe(raw * 1000);
    }
  });

  it("refuses every date-like string the generic parser would accept", () => {
    for (const raw of [
      "2026-08-28T12:00:00Z",
      "2026-08-28",
      "2026-08-28T12:00:00.000Z",
      "not a date",
      "some time yesterday",
    ]) {
      const outcome = normalizeRtdsObservationInstant(raw);
      expect(outcome.status).toBe("invalid");
      // And the tolerant publisher parser is unchanged, which is the whole
      // point of keeping the two apart.
      expect(normalizeRtdsPublisherInstant("2026-08-28T12:00:00Z").status).toBe("ok");
    }
  });

  it("refuses digit strings that are not bare milliseconds", () => {
    for (const raw of [
      " 1785178800000",
      "1785178800000 ",
      "+1785178800000",
      "-1785178800000",
      "1785178800000.0",
      "1.7851788e12",
      "0x1a",
      "１７８５",
    ]) {
      expect(normalizeRtdsObservationInstant(raw).status).toBe("invalid");
    }
  });

  it("refuses a number that is not a safe whole millisecond count", () => {
    for (const raw of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeRtdsObservationInstant(raw).status).toBe("invalid");
    }
    expect(normalizeRtdsObservationInstant("9007199254740993").status).toBe("invalid");
  });

  it("refuses a value that is not an epoch at all", () => {
    for (const raw of [true, {}, [], 1785178800000n, () => 1785178800000]) {
      expect(normalizeRtdsObservationInstant(raw).status).toBe("invalid");
    }
  });

  it("refuses a negative or unrepresentable instant", () => {
    // No plausibility WINDOW is invented — how old is too old is operator
    // policy, and it lives in the staleness threshold (RTDS-U1) — but a
    // pre-1970 observation time cannot be a Chainlink observation, and beyond
    // the `Date` range `toISOString()` throws inside the message loop.
    expect(normalizeRtdsObservationInstant(-1).status).toBe("invalid");
    expect(normalizeRtdsObservationInstant(9e15).status).toBe("invalid");
    expect(normalizeRtdsObservationInstant(8.64e15).status).toBe("ok");
  });

  it("reports absence as absence rather than substituting an instant", () => {
    for (const raw of [undefined, null, ""]) {
      expect(normalizeRtdsObservationInstant(raw).status).toBe("absent");
    }
  });
});

describe("the publisher timestamp keeps the tolerant reading, deliberately", () => {
  it("accepts the forms the observation time refuses", () => {
    // Nothing is computed from it: it decorates provenance, and its documented
    // type is `timestamp: datetime | None`. An unusable one costs the
    // decoration, never the observation.
    expect(normalizeRtdsPublisherInstant("2026-08-28").status).toBe("ok");
    expect(normalizeRtdsPublisherInstant(1785178800123).status).toBe("ok");
    expect(normalizeRtdsPublisherInstant(undefined).status).toBe("absent");
    expect(normalizeRtdsPublisherInstant(null).status).toBe("absent");
    expect(normalizeRtdsPublisherInstant("not a date").status).toBe("invalid");
    expect(normalizeRtdsPublisherInstant(1.5).status).toBe("invalid");
  });
});

describe("instants", () => {
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
