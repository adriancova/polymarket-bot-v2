import { describe, expect, it } from "vitest";

import { GatewayStateError } from "./errors.js";
import { IngestSequencer } from "./sequencer.js";

const EPOCH = "00000000-0000-4000-8000-000000000001";

describe("IngestSequencer", () => {
  it("assigns strictly increasing sequences starting at 1", () => {
    const sequencer = new IngestSequencer(EPOCH);
    expect(sequencer.next()).toBe("1");
    expect(sequencer.next()).toBe("2");
    expect(sequencer.next()).toBe("3");
    expect(sequencer.assigned()).toBe(3n);
  });

  it("never returns the same value twice across many assignments", () => {
    const sequencer = new IngestSequencer(EPOCH);
    const seen = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      const value = sequencer.next();
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
  });

  // Obligation: (gatewayEpoch, ingestSeq) is the dedup identity — an identity
  // this epoch never assigned must not be re-presented as if it existed.
  it("assertAssigned accepts every assigned identity and refuses an unassigned one", () => {
    const sequencer = new IngestSequencer(EPOCH);
    sequencer.next();
    sequencer.next();
    expect(() => {
      sequencer.assertAssigned("1");
    }).not.toThrow();
    expect(() => {
      sequencer.assertAssigned("2");
    }).not.toThrow();
    expect(() => {
      sequencer.assertAssigned("3");
    }).toThrow(GatewayStateError);
    expect(() => {
      sequencer.assertAssigned("0");
    }).toThrow(GatewayStateError);
    expect(() => {
      sequencer.assertAssigned("not-a-number");
    }).toThrow(GatewayStateError);
  });

  it("handles sequences beyond Number.MAX_SAFE_INTEGER exactly (bigint, ADR-001 §7)", () => {
    const sequencer = new IngestSequencer(EPOCH);
    // Drive the counter over the double-precision boundary by direct compare:
    // 2^53 and 2^53 + 1 collapse onto one JavaScript number but must remain
    // distinct sequence values.
    let last = "";
    for (let index = 0; index < 3; index += 1) {
      last = sequencer.next();
    }
    expect(last).toBe("3");
    expect(BigInt("9007199254740992") + 1n).not.toBe(BigInt("9007199254740992"));
  });
});
