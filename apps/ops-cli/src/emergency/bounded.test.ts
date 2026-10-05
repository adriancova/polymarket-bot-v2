/**
 * `withinBound`: an answer within the bound is the answer; a rejection is the
 * rejection; no answer is UNANSWERED after the bound, and a late rejection
 * never surfaces unhandled.
 */

import { describe, expect, it } from "vitest";

import { withinBound } from "./bounded.js";

describe("withinBound", () => {
  it("an answer within the bound", async () => {
    expect(await withinBound(1_000, () => Promise.resolve(7))).toEqual({ kind: "ANSWERED", value: 7 });
  });

  it("a rejection within the bound is the caller's to handle", async () => {
    await expect(withinBound(1_000, () => Promise.reject(new Error("refused")))).rejects.toThrow("refused");
  });

  it("a synchronous throw is a rejection too", async () => {
    await expect(
      withinBound(1_000, () => {
        throw new Error("sync");
      }),
    ).rejects.toThrow("sync");
  });

  it("no answer: UNANSWERED after the bound", async () => {
    const started = Date.now();
    expect(await withinBound(25, () => new Promise<never>(() => undefined))).toEqual({ kind: "UNANSWERED" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  });

  it("a late rejection after UNANSWERED is observed, never unhandled", async () => {
    let reject: (reason: unknown) => void = () => undefined;
    const late = new Promise<never>((_, fail) => {
      reject = fail;
    });
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      expect(await withinBound(5, () => late)).toEqual({ kind: "UNANSWERED" });
      reject(new Error("late"));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
