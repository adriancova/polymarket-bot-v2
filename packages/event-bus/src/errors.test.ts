import { describe, expect, it } from "vitest";

import {
  EventBusCheckpointError,
  EventBusConfigurationError,
  EventBusEntryError,
  EventBusEnvelopeError,
  EventBusError,
  EventBusOrderingError,
  EventBusPublishQueueFullError,
  EventBusResyncRequiredError,
  EventBusStateError,
  EventBusUnavailableError,
} from "./errors.js";

describe("event-bus errors", () => {
  it("gives every failure mode a stable code a caller can branch on", () => {
    const cases = [
      [new EventBusConfigurationError("x"), "EVENT_BUS_CONFIGURATION"],
      [new EventBusEnvelopeError("x"), "EVENT_BUS_ENVELOPE_INVALID"],
      [new EventBusOrderingError("x"), "EVENT_BUS_ORDERING_VIOLATION"],
      [new EventBusEntryError("x"), "EVENT_BUS_ENTRY_UNREADABLE"],
      [new EventBusCheckpointError("x"), "EVENT_BUS_CHECKPOINT_INVALID"],
      [new EventBusResyncRequiredError("x"), "EVENT_BUS_RESYNC_REQUIRED"],
      [new EventBusStateError("x"), "EVENT_BUS_STATE"],
      [new EventBusUnavailableError("x"), "EVENT_BUS_UNAVAILABLE"],
      [new EventBusPublishQueueFullError("x"), "EVENT_BUS_PUBLISH_QUEUE_FULL"],
    ] as const;

    for (const [error, code] of cases) {
      expect(error).toBeInstanceOf(EventBusError);
      expect(error.code).toBe(code);
      expect(error.name).toBe(error.constructor.name);
    }
  });

  it("carries a structured details bag rather than only a message", () => {
    const error = new EventBusOrderingError("out of order", {
      gatewayEpoch: "epoch-a",
      ingestSeq: "4",
    });

    expect(error.details).toStrictEqual({ gatewayEpoch: "epoch-a", ingestSeq: "4" });
  });

  it("preserves the underlying failure as a cause", () => {
    const cause = new Error("connection reset");

    expect(new EventBusUnavailableError("unreachable", {}, cause).cause).toBe(cause);
  });

  it("does not invent a cause when none was given", () => {
    expect(new EventBusUnavailableError("unreachable").cause).toBeUndefined();
  });

  it("makes a full publish queue reach the same halt path as an unreachable transport", () => {
    // §8.3: a queue that cannot accept an event halts affected trading. A
    // caller that branches on `EventBusUnavailableError` for its halt path must
    // therefore catch this one too, while an operator can still tell a
    // saturated producer from a dead server by the code.
    const error = new EventBusPublishQueueFullError("full", { pending: 8, maxPending: 8 });

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    expect(error.code).toBe("EVENT_BUS_PUBLISH_QUEUE_FULL");
    expect(error.details).toStrictEqual({ pending: 8, maxPending: 8 });
  });
});
