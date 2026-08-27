import { describe, expect, it } from "vitest";

import {
  assertMaxTrackedEpochs,
  DEFAULT_MAX_TRACKED_EPOCHS,
  EpochOrderTracker,
  parseIngestSeq,
} from "./epoch-order.js";
import { EventBusConfigurationError, EventBusEnvelopeError } from "./errors.js";

describe("parseIngestSeq", () => {
  it("parses a canonical unsigned integer string as a bigint", () => {
    expect(parseIngestSeq("0")).toBe(0n);
    expect(parseIngestSeq("42")).toBe(42n);
  });

  it("keeps values that JavaScript numbers cannot distinguish", () => {
    const low = parseIngestSeq("9007199254740992");
    const high = parseIngestSeq("9007199254740993");

    expect(low).not.toBe(high);
    expect(high > low).toBe(true);
    // The whole reason §7.1 serializes these as strings: as numbers they are
    // the same value, so a `Number`-based comparison would report no change.
    expect(Number("9007199254740992")).toBe(Number("9007199254740993"));
  });

  it("rejects a non-canonical or non-numeric value", () => {
    for (const value of ["", "01", "-1", "1.0", "1e3", " 1", "abc"]) {
      expect(() => parseIngestSeq(value)).toThrow(EventBusEnvelopeError);
    }
  });
});

describe("EpochOrderTracker", () => {
  it("reports the first observation for an epoch as advancing", () => {
    const tracker = new EpochOrderTracker();

    const observation = tracker.observe("epoch-a", "5");

    expect(observation.advanced).toBe(true);
    expect(observation.previousIngestSeq).toBeUndefined();
    expect(tracker.lastIngestSeq("epoch-a")).toBe(5n);
  });

  it("advances only on a strictly increasing ingestSeq", () => {
    const tracker = new EpochOrderTracker();
    tracker.observe("epoch-a", "5");

    expect(tracker.observe("epoch-a", "6").advanced).toBe(true);
    expect(tracker.observe("epoch-a", "6").advanced).toBe(false);
    expect(tracker.observe("epoch-a", "4").advanced).toBe(false);
    expect(tracker.lastIngestSeq("epoch-a")).toBe(6n);
  });

  it("compares above Number.MAX_SAFE_INTEGER without losing precision", () => {
    const tracker = new EpochOrderTracker();
    tracker.observe("epoch-a", "9007199254740992");

    // Both values collapse to 9007199254740992 as JavaScript numbers, so a
    // `Number`-based tracker would call the first "not advancing" and the
    // second "advancing" — exactly backwards.
    expect(tracker.observe("epoch-a", "9007199254740993").advanced).toBe(true);
    expect(tracker.observe("epoch-a", "9007199254740992").advanced).toBe(false);
  });

  it("keeps epochs independent so two of them are never one sequence", () => {
    const tracker = new EpochOrderTracker();
    tracker.observe("epoch-a", "100");

    // A new gateway epoch restarts ingestSeq; that is not a regression.
    expect(tracker.observe("epoch-b", "1").advanced).toBe(true);
    expect(tracker.lastIngestSeq("epoch-a")).toBe(100n);
    expect(tracker.lastIngestSeq("epoch-b")).toBe(1n);
  });

  it("does not let a non-advancing observation move the cursor", () => {
    const tracker = new EpochOrderTracker();
    tracker.observe("epoch-a", "5");

    tracker.observe("epoch-a", "3");

    expect(tracker.lastIngestSeq("epoch-a")).toBe(5n);
    // A caller that refused and retried the same value gets the same answer.
    expect(tracker.observe("epoch-a", "3").advanced).toBe(false);
  });

  it("bounds the number of tracked epochs, evicting the least recently used", () => {
    const tracker = new EpochOrderTracker({ maxTrackedEpochs: 2 });
    tracker.observe("epoch-a", "1");
    tracker.observe("epoch-b", "1");
    tracker.observe("epoch-a", "2");

    tracker.observe("epoch-c", "1");

    expect(tracker.trackedEpochCount).toBe(2);
    expect(tracker.lastIngestSeq("epoch-b")).toBeUndefined();
    expect(tracker.lastIngestSeq("epoch-a")).toBe(2n);
    expect(tracker.lastIngestSeq("epoch-c")).toBe(1n);
  });

  it("forgets every epoch on reset", () => {
    const tracker = new EpochOrderTracker();
    tracker.observe("epoch-a", "9");

    tracker.reset();

    expect(tracker.trackedEpochCount).toBe(0);
    expect(tracker.observe("epoch-a", "1").advanced).toBe(true);
  });

  it("rejects an unusable epoch bound", () => {
    expect(() => new EpochOrderTracker({ maxTrackedEpochs: 0 })).toThrow(
      EventBusConfigurationError,
    );
    expect(() => assertMaxTrackedEpochs(1.5)).toThrow(EventBusConfigurationError);
    expect(() => assertMaxTrackedEpochs(DEFAULT_MAX_TRACKED_EPOCHS)).not.toThrow();
  });
});
