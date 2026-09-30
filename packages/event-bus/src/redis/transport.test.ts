/**
 * `readPublishBatchReply` (`THROUGHPUT-1b`): the batch script's reply is
 * believed only when it accounts for exactly the run that was sent.
 *
 * The real script's refusals are exercised against a server in
 * `test/integration/event-bus/publish-batch.test.ts`; the branches here are
 * the ones a correct script never takes — which is exactly why they are
 * pinned: a reply that does not add up must halt the caller, not be read as a
 * partial success.
 */

import { describe, expect, it } from "vitest";

import { EventBusUnavailableError } from "../errors.js";
import { readPublishBatchReply } from "./transport.js";

describe("readPublishBatchReply", () => {
  it("reads a run's first ordinal and whether the trim failed", () => {
    expect(readPublishBatchReply(["ok", "11", "15", ""], "s", "e", 5)).toStrictEqual({
      firstSequence: 11,
      trimFailed: false,
    });
    expect(readPublishBatchReply(["ok", "1", "1", "ERR no trim"], "s", "e", 1)).toStrictEqual({
      firstSequence: 1,
      trimFailed: true,
    });
  });

  it("turns a script refusal into an unavailable error naming the code; the ceiling says nothing was appended", () => {
    let caught: unknown;
    try {
      readPublishBatchReply(["err", "counter-write-failed", "NOPERM"], "s", "e", 3);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EventBusUnavailableError);
    expect((caught as EventBusUnavailableError).details["reason"]).toBe("counter-write-failed");

    expect(() => readPublishBatchReply(["err", "counter-ceiling", "9007199254740991"], "s", "e", 2)).toThrow(
      /nothing was appended/u,
    );
  });

  it("refuses a reply that does not account for exactly the run", () => {
    // Fewer ordinals than envelopes: some of the run would be unaccounted for.
    expect(() => readPublishBatchReply(["ok", "1", "3", ""], "s", "e", 4)).toThrow(EventBusUnavailableError);
    // More ordinals than envelopes.
    expect(() => readPublishBatchReply(["ok", "1", "5", ""], "s", "e", 4)).toThrow(EventBusUnavailableError);
    // No ordinals, an unknown status, an ordinal below 1, or past the safe range.
    expect(() => readPublishBatchReply(["ok"], "s", "e", 1)).toThrow(EventBusUnavailableError);
    expect(() => readPublishBatchReply(["maybe", "1", "1"], "s", "e", 1)).toThrow(EventBusUnavailableError);
    expect(() => readPublishBatchReply(["ok", "0", "0", ""], "s", "e", 1)).toThrow(EventBusUnavailableError);
    expect(() => readPublishBatchReply(["ok", "9007199254740993", "9007199254740993", ""], "s", "e", 1)).toThrow(
      EventBusUnavailableError,
    );
  });
});
