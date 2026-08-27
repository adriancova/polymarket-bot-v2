import { describe, expect, it } from "vitest";

import { EventBusCheckpointError } from "../errors.js";
import {
  createCheckpoint,
  decodeCheckpointToken,
  encodeCheckpointToken,
  readCheckpoint,
} from "./checkpoint.js";

const TRANSPORT = "redis-streams";
const STREAM = "market";
const ORIGIN = "0123456789abcdef0123456789abcdef";
const OTHER_ORIGIN = "fedcba9876543210fedcba9876543210";

describe("checkpoint tokens", () => {
  it("round-trips a position and the instance it was taken in", () => {
    const position = { entryId: "1758000000123-4", sequence: 91 };

    expect(decodeCheckpointToken(encodeCheckpointToken(ORIGIN, position))).toStrictEqual({
      origin: ORIGIN,
      ...position,
    });
  });

  it("encodes the origin position", () => {
    expect(
      decodeCheckpointToken(encodeCheckpointToken(ORIGIN, { entryId: "0-0", sequence: 0 })),
    ).toStrictEqual({ origin: ORIGIN, entryId: "0-0", sequence: 0 });
  });

  it("refuses to encode a malformed position", () => {
    expect(() => encodeCheckpointToken(ORIGIN, { entryId: "not-an-id", sequence: 1 })).toThrow(
      EventBusCheckpointError,
    );
    expect(() => encodeCheckpointToken(ORIGIN, { entryId: "1-0", sequence: -1 })).toThrow(
      EventBusCheckpointError,
    );
    expect(() => encodeCheckpointToken(ORIGIN, { entryId: "1-0", sequence: 1.5 })).toThrow(
      EventBusCheckpointError,
    );
  });

  it("refuses to encode a marker it did not mint", () => {
    for (const origin of ["", "not-hex", ORIGIN.toUpperCase(), ORIGIN.slice(0, 31), `${ORIGIN}0`]) {
      expect(() => encodeCheckpointToken(origin, { entryId: "1-0", sequence: 1 })).toThrow(
        EventBusCheckpointError,
      );
    }
  });

  it("refuses a token it did not issue", () => {
    for (const token of [
      "",
      "1758000000123-4",
      `ebc0:${ORIGIN}:1758000000123-4:91`,
      // The version this format replaced: it names no instance, so a position
      // in it cannot be shown to belong anywhere.
      "ebc1:1758000000123-4:91",
      `ebc2:${ORIGIN}:1758000000123-4`,
      `ebc2:${ORIGIN}:1758000000123-4:x`,
      `ebc2:${ORIGIN}:1758000000123-4:007`,
      `ebc2:${ORIGIN}:oops:91`,
      "ebc2:not-a-marker:1758000000123-4:91",
      `ebc2:${ORIGIN.slice(0, 30)}:1758000000123-4:91`,
    ]) {
      expect(() => decodeCheckpointToken(token)).toThrow(EventBusCheckpointError);
    }
  });

  it("refuses an ordinal this process cannot represent exactly", () => {
    expect(() => decodeCheckpointToken(`ebc2:${ORIGIN}:1-0:9007199254740993`)).toThrow(
      /represent exactly/u,
    );
  });

  it("mints a different token for the same position in a different instance", () => {
    const position = { entryId: "7-0", sequence: 3 };

    expect(encodeCheckpointToken(ORIGIN, position)).not.toBe(
      encodeCheckpointToken(OTHER_ORIGIN, position),
    );
  });
});

describe("readCheckpoint", () => {
  it("accepts a checkpoint minted for the same transport and stream", () => {
    const checkpoint = createCheckpoint(TRANSPORT, STREAM, ORIGIN, { entryId: "7-0", sequence: 3 });

    expect(readCheckpoint(TRANSPORT, STREAM, checkpoint)).toStrictEqual({
      origin: ORIGIN,
      entryId: "7-0",
      sequence: 3,
    });
  });

  it("refuses a checkpoint from another stream", () => {
    const checkpoint = createCheckpoint(TRANSPORT, "reference", ORIGIN, {
      entryId: "7-0",
      sequence: 3,
    });

    expect(() => readCheckpoint(TRANSPORT, STREAM, checkpoint)).toThrow(/belongs to stream/u);
  });

  it("refuses a checkpoint from another transport", () => {
    const checkpoint = createCheckpoint("some-future-transport", STREAM, ORIGIN, {
      entryId: "7-0",
      sequence: 3,
    });

    expect(() => readCheckpoint(TRANSPORT, STREAM, checkpoint)).toThrow(/was issued by transport/u);
  });

  it("reports which instance a checkpoint was taken in, so a caller can refuse it", () => {
    // The transport compares this against the instance the server reports; the
    // decode itself cannot know which instance is the right one.
    const checkpoint = createCheckpoint(TRANSPORT, STREAM, OTHER_ORIGIN, {
      entryId: "7-0",
      sequence: 3,
    });

    expect(readCheckpoint(TRANSPORT, STREAM, checkpoint).origin).toBe(OTHER_ORIGIN);
  });
});
