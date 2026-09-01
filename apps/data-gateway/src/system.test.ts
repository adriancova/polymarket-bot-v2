import { describe, expect, it, vi } from "vitest";

import { Uuidv7Schema } from "@polymarket-bot/domain";

import { systemGatewayLifetime, systemGatewayTimers, uuidV7At } from "./system.js";

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

describe("systemGatewayLifetime (round-2 review R2-H5)", () => {
  it("acquire() takes a REFERENCED handle and release clears exactly that handle", () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    try {
      const release = systemGatewayLifetime().acquire();
      const handle = setSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
      // The anchor is the one deliberately referenced handle in this app:
      // while held, the host process cannot run out of event-loop work and
      // exit mid-recording (the R2-H5 failure).
      expect(handle.hasRef()).toBe(true);
      expect(clearSpy).not.toHaveBeenCalledWith(handle);
      release();
      // Released is CLEARED, not merely unref'd: a requested shutdown must
      // not leave a live interval behind.
      expect(clearSpy).toHaveBeenCalledWith(handle);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});

describe("systemGatewayTimers", () => {
  it("still unrefs every scheduled handle, so requested shutdowns stay prompt", () => {
    // The R2-H5 fix must NOT weaken the unref policy: process liveness is
    // owned by the lifetime anchor, and ordinary scheduled work must never
    // hold the process open past a shutdown.
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const timers = systemGatewayTimers();
      const cancelInterval = timers.setInterval(() => undefined, 60_000);
      const cancelTimeout = timers.setTimeout(() => undefined, 60_000);
      const intervalHandle = setIntervalSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
      const timeoutHandle = setTimeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
      expect(intervalHandle.hasRef()).toBe(false);
      expect(timeoutHandle.hasRef()).toBe(false);
      cancelInterval();
      cancelTimeout();
    } finally {
      setIntervalSpy.mockRestore();
      setTimeoutSpy.mockRestore();
    }
  });
});
