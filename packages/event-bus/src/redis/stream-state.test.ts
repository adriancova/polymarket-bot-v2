import { describe, expect, it } from "vitest";

import { EventBusUnavailableError } from "../errors.js";
import { entryIdTimestampMs, parseStreamState } from "./stream-state.js";
import { resolveResumePosition } from "./subscription.js";

const ORIGIN = "0123456789abcdef0123456789abcdef";
const populated = [
  "10",
  "3",
  "1758000000123-0",
  "8",
  "1758000000900-2",
  "1758000001",
  "500000",
  ORIGIN,
];
const empty = ["10", "0", "", "", "", "1758000001", "500000", ORIGIN];

describe("parseStreamState", () => {
  it("parses a populated stream", () => {
    expect(parseStreamState(populated)).toStrictEqual({
      publishedTotal: 10,
      depth: 3,
      firstEntryId: "1758000000123-0",
      firstSequence: 8,
      lastEntryId: "1758000000900-2",
      serverTimeMs: 1_758_000_001_500,
      oldestEntryAtMs: 1_758_000_000_123,
      origin: ORIGIN,
    });
  });

  it("parses an emptied stream without inventing a position", () => {
    expect(parseStreamState(empty)).toStrictEqual({
      publishedTotal: 10,
      depth: 0,
      firstEntryId: undefined,
      firstSequence: undefined,
      lastEntryId: undefined,
      serverTimeMs: 1_758_000_001_500,
      oldestEntryAtMs: undefined,
      origin: ORIGIN,
    });
  });

  it("reports a missing instance marker rather than inventing one", () => {
    // A stream whose marker is gone can still be read; what it cannot do is
    // vouch for a stored position, and the absent marker is how that is known.
    expect(parseStreamState(["10", "0", "", "", "", "1", "0", ""]).origin).toBeUndefined();
  });

  it("refuses a reply it cannot read rather than defaulting", () => {
    expect(() => parseStreamState([])).toThrow(EventBusUnavailableError);
    expect(() => parseStreamState(["x", "0", "", "", "", "1", "0", ""])).toThrow(
      EventBusUnavailableError,
    );
    expect(() => parseStreamState(["-1", "0", "", "", "", "1", "0", ""])).toThrow(
      EventBusUnavailableError,
    );
  });
});

describe("entryIdTimestampMs", () => {
  it("reads the publication time an entry id carries", () => {
    expect(entryIdTimestampMs("1758000000123-7")).toBe(1_758_000_000_123);
  });

  it("returns nothing rather than guessing for an unrecognised id", () => {
    expect(entryIdTimestampMs("abc-1")).toBeUndefined();
  });
});

describe("resolveResumePosition", () => {
  it("replays everything still retained", () => {
    expect(resolveResumePosition(parseStreamState(populated), "oldest-retained")).toStrictEqual({
      entryId: "0-0",
      sequence: 7,
    });
  });

  it("skips to the end when asked", () => {
    expect(resolveResumePosition(parseStreamState(populated), "newest")).toStrictEqual({
      entryId: "1758000000900-2",
      sequence: 10,
    });
  });

  it("treats an emptied stream's oldest and newest as the same place", () => {
    const state = parseStreamState(empty);

    expect(resolveResumePosition(state, "oldest-retained")).toStrictEqual(
      resolveResumePosition(state, "newest"),
    );
    expect(resolveResumePosition(state, "oldest-retained")).toStrictEqual({
      entryId: "0-0",
      sequence: 10,
    });
  });
});
