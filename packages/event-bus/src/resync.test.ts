import { describe, expect, it } from "vitest";

import { EventBusConfigurationError } from "./errors.js";
import { checkSequenceContinuity } from "./resync.js";

describe("checkSequenceContinuity — delivery", () => {
  it("is continuous when the arriving event is the next one", () => {
    expect(
      checkSequenceContinuity({
        source: "delivery",
        lastDeliveredSequence: 4,
        arrivingSequence: 5,
      }),
    ).toStrictEqual({ kind: "continuous" });
  });

  it("counts exactly the events retention removed", () => {
    expect(
      checkSequenceContinuity({
        source: "delivery",
        lastDeliveredSequence: 2,
        arrivingSequence: 8,
      }),
    ).toStrictEqual({ kind: "gap", missedEventCount: 5 });
  });

  it("treats a re-arriving ordinal as an inconsistency, not a gap", () => {
    const verdict = checkSequenceContinuity({
      source: "delivery",
      lastDeliveredSequence: 9,
      arrivingSequence: 9,
    });

    expect(verdict.kind).toBe("inconsistent");
  });

  it("handles the very first delivery", () => {
    expect(
      checkSequenceContinuity({
        source: "delivery",
        lastDeliveredSequence: 0,
        arrivingSequence: 1,
      }),
    ).toStrictEqual({ kind: "continuous" });
  });
});

describe("checkSequenceContinuity — stream state", () => {
  it("is continuous when the consumer sits inside the retained range", () => {
    expect(
      checkSequenceContinuity({
        source: "stream-state",
        lastDeliveredSequence: 7,
        firstRetainedSequence: 3,
        publishedTotal: 10,
      }),
    ).toStrictEqual({ kind: "continuous" });
  });

  it("is continuous when the consumer is exactly caught up", () => {
    expect(
      checkSequenceContinuity({
        source: "stream-state",
        lastDeliveredSequence: 10,
        firstRetainedSequence: 8,
        publishedTotal: 10,
      }),
    ).toStrictEqual({ kind: "continuous" });
  });

  it("is continuous when the next retained event is the next one owed", () => {
    expect(
      checkSequenceContinuity({
        source: "stream-state",
        lastDeliveredSequence: 5,
        firstRetainedSequence: 6,
        publishedTotal: 10,
      }),
    ).toStrictEqual({ kind: "continuous" });
  });

  it("reports the gap when retention overtook the consumer", () => {
    expect(
      checkSequenceContinuity({
        source: "stream-state",
        lastDeliveredSequence: 2,
        firstRetainedSequence: 8,
        publishedTotal: 10,
      }),
    ).toStrictEqual({ kind: "gap", missedEventCount: 5 });
  });

  it("distinguishes an empty stream with nothing owed from one that was emptied", () => {
    expect(
      checkSequenceContinuity({
        source: "stream-state",
        lastDeliveredSequence: 4,
        firstRetainedSequence: undefined,
        publishedTotal: 4,
      }),
    ).toStrictEqual({ kind: "continuous" });

    expect(
      checkSequenceContinuity({
        source: "stream-state",
        lastDeliveredSequence: 4,
        firstRetainedSequence: undefined,
        publishedTotal: 9,
      }),
    ).toStrictEqual({ kind: "gap", missedEventCount: 5 });
  });

  it("reports an inconsistency when the stream knows less than the consumer", () => {
    const verdict = checkSequenceContinuity({
      source: "stream-state",
      lastDeliveredSequence: 12,
      firstRetainedSequence: undefined,
      publishedTotal: 3,
    });

    expect(verdict.kind).toBe("inconsistent");
    if (verdict.kind === "inconsistent") {
      expect(verdict.detail).toContain("truncated or reset");
    }
  });

  it("rejects a non-integer input rather than guessing", () => {
    expect(() =>
      checkSequenceContinuity({
        source: "stream-state",
        lastDeliveredSequence: -1,
        firstRetainedSequence: undefined,
        publishedTotal: 0,
      }),
    ).toThrow(EventBusConfigurationError);
  });
});
