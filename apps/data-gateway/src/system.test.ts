import { describe, expect, it } from "vitest";

import { Uuidv7Schema } from "@polymarket-bot/domain";

import { uuidV7At } from "./system.js";

describe("uuidV7At", () => {
  it("produces canonical lowercase UUIDv7 values the frozen domain schema accepts", () => {
    let cursor = 0;
    const id = uuidV7At(1_772_400_000_000, () => {
      cursor += 1;
      return (cursor * 37) % 256;
    });
    expect(Uuidv7Schema.safeParse(id).success).toBe(true);
  });

  it("encodes the supplied instant in the time bits", () => {
    const atMs = 1_772_400_000_000;
    const id = uuidV7At(atMs, () => 0);
    const timeHex = id.slice(0, 8) + id.slice(9, 13);
    expect(Number.parseInt(timeHex, 16)).toBe(atMs);
  });

  it("varies with the random source, not with hidden global state", () => {
    const a = uuidV7At(1, () => 1);
    const b = uuidV7At(1, () => 2);
    const aAgain = uuidV7At(1, () => 1);
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
  });
});
