/**
 * `withDeadline` (`OUTAGE-1`): the race a blocking read, the handshake and
 * the courtesy `QUIT` are bounded by. The server-backed evidence is
 * `test/integration/event-bus/response-deadline.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withDeadline } from "./deadline.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A promise the test settles by hand. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("withDeadline", () => {
  it("answers with the operation's value when it settles first, and leaves no timer behind", async () => {
    const operation = deferred<string>();
    const raced = withDeadline(operation.promise, 1_000, () => new Error("expired"));
    operation.resolve("reply");

    await expect(raced).resolves.toBe("reply");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with the operation's own error when it fails first", async () => {
    const operation = deferred<string>();
    const raced = withDeadline(operation.promise, 1_000, () => new Error("expired"));
    const failure = new Error("connection reset");
    operation.reject(failure);

    await expect(raced).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails with expired() once the bound passes, and not one millisecond before", async () => {
    const operation = deferred<string>();
    const expired = new Error("no reply within 1000 ms");
    let outcome: unknown = "pending";
    void withDeadline(operation.promise, 1_000, () => expired).then(
      (value) => {
        outcome = value;
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await vi.advanceTimersByTimeAsync(999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe(expired);
  });

  it("a late reply to an abandoned operation changes nothing, and a late failure is never unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const late = deferred<string>();
      const raced = withDeadline(late.promise, 10, () => new Error("expired"));
      const settled = expect(raced).rejects.toThrow("expired");
      await vi.advanceTimersByTimeAsync(10);
      await settled;

      late.reject(new Error("the reply that came after the caller gave up"));
      vi.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
