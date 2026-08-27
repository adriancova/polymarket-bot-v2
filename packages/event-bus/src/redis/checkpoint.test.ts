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

describe("checkpoint tokens", () => {
  it("round-trips a position", () => {
    const position = { entryId: "1758000000123-4", sequence: 91 };

    expect(decodeCheckpointToken(encodeCheckpointToken(position))).toStrictEqual(position);
  });

  it("encodes the origin position", () => {
    expect(decodeCheckpointToken(encodeCheckpointToken({ entryId: "0-0", sequence: 0 }))).toStrictEqual(
      { entryId: "0-0", sequence: 0 },
    );
  });

  it("refuses to encode a malformed position", () => {
    expect(() => encodeCheckpointToken({ entryId: "not-an-id", sequence: 1 })).toThrow(
      EventBusCheckpointError,
    );
    expect(() => encodeCheckpointToken({ entryId: "1-0", sequence: -1 })).toThrow(
      EventBusCheckpointError,
    );
    expect(() => encodeCheckpointToken({ entryId: "1-0", sequence: 1.5 })).toThrow(
      EventBusCheckpointError,
    );
  });

  it("refuses a token it did not issue", () => {
    for (const token of [
      "",
      "1758000000123-4",
      "ebc0:1758000000123-4:91",
      "ebc1:1758000000123-4",
      "ebc1:1758000000123-4:x",
      "ebc1:1758000000123-4:007",
      "ebc1:oops:91",
    ]) {
      expect(() => decodeCheckpointToken(token)).toThrow(EventBusCheckpointError);
    }
  });

  it("refuses an ordinal this process cannot represent exactly", () => {
    expect(() => decodeCheckpointToken("ebc1:1-0:9007199254740993")).toThrow(
      /represent exactly/u,
    );
  });
});

describe("readCheckpoint", () => {
  it("accepts a checkpoint minted for the same transport and stream", () => {
    const checkpoint = createCheckpoint(TRANSPORT, STREAM, { entryId: "7-0", sequence: 3 });

    expect(readCheckpoint(TRANSPORT, STREAM, checkpoint)).toStrictEqual({
      entryId: "7-0",
      sequence: 3,
    });
  });

  it("refuses a checkpoint from another stream", () => {
    const checkpoint = createCheckpoint(TRANSPORT, "reference", { entryId: "7-0", sequence: 3 });

    expect(() => readCheckpoint(TRANSPORT, STREAM, checkpoint)).toThrow(
      /belongs to stream/u,
    );
  });

  it("refuses a checkpoint from another transport", () => {
    const checkpoint = createCheckpoint("some-future-transport", STREAM, {
      entryId: "7-0",
      sequence: 3,
    });

    expect(() => readCheckpoint(TRANSPORT, STREAM, checkpoint)).toThrow(/was issued by transport/u);
  });
});
