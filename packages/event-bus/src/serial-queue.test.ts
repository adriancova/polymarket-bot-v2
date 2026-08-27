import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { EventBusConfigurationError, EventBusPublishQueueFullError } from "./errors.js";
import { KeyedSerialQueue } from "./serial-queue.js";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolveFn, rejectFn) => {
    resolve = resolveFn;
    reject = rejectFn;
  });
  return { promise, resolve, reject };
}

describe("KeyedSerialQueue", () => {
  it("runs one key's operations in submission order, never overlapping them", async () => {
    const queue = new KeyedSerialQueue();
    const events: string[] = [];
    const first = deferred<void>();

    const slow = queue.run("epoch", async () => {
      events.push("first:start");
      await first.promise;
      events.push("first:end");
    });
    const fast = queue.run("epoch", async () => {
      events.push("second:start");
      await Promise.resolve();
      events.push("second:end");
    });

    // The second operation has not begun even though it needs no waiting.
    await Promise.resolve();
    expect(events).toStrictEqual(["first:start"]);

    first.resolve();
    await Promise.all([slow, fast]);

    expect(events).toStrictEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("closes the check-then-act window a shared cursor would otherwise leave open", async () => {
    // The publisher's ordering guard in miniature: read the cursor, do work,
    // then advance it. Without serialization both calls read `0` and both
    // "succeed"; with it, the second sees the first's cursor and is refused.
    const queue = new KeyedSerialQueue();
    let cursor = 0;
    const accepted: number[] = [];

    async function publish(value: number): Promise<void> {
      await queue.run("epoch", async () => {
        if (value <= cursor) {
          throw new Error(`${String(value)} does not advance past ${String(cursor)}`);
        }
        await Promise.resolve();
        cursor = value;
        accepted.push(value);
      });
    }

    const outcomes = await Promise.allSettled([publish(2), publish(1)]);

    expect(outcomes.map((outcome) => outcome.status)).toStrictEqual(["fulfilled", "rejected"]);
    expect(accepted).toStrictEqual([2]);
    expect(cursor).toBe(2);
  });

  it("lets different keys run concurrently", async () => {
    const queue = new KeyedSerialQueue();
    const blocked = deferred<void>();
    const events: string[] = [];

    const held = queue.run("epoch-a", async () => {
      events.push("a:start");
      await blocked.promise;
      events.push("a:end");
    });
    const free = queue.run("epoch-b", async () => {
      events.push("b:start");
    });

    await free;
    expect(events).toStrictEqual(["a:start", "b:start"]);

    blocked.resolve();
    await held;
  });

  it("does not let one failure reject or block what is queued behind it", async () => {
    const queue = new KeyedSerialQueue();
    const failing = queue.run("epoch", async () => {
      await Promise.resolve();
      throw new Error("refused");
    });
    const following = queue.run("epoch", async () => "delivered");

    await expect(failing).rejects.toThrow("refused");
    await expect(following).resolves.toBe("delivered");
  });

  it("forgets a key once nothing is queued for it", async () => {
    const queue = new KeyedSerialQueue();

    await queue.run("epoch", async () => undefined);

    expect(queue.activeKeyCount).toBe(0);
  });

  it("refuses admission past its bound instead of queuing without limit", async () => {
    // Round-2 review, H1: the unbounded version admitted 10 000 operations
    // behind one stalled operation, and the only observable number was how many
    // keys were active.
    const queue = new KeyedSerialQueue({ maxPending: 3 });
    const stall = deferred<void>();
    const admitted = [
      queue.run("epoch", async () => await stall.promise),
      queue.run("epoch", async () => undefined),
      queue.run("epoch", async () => undefined),
    ];

    let refusal: unknown;
    try {
      await queue.run("epoch", async () => undefined);
    } catch (error) {
      refusal = error;
    }

    expect(refusal).toBeInstanceOf(EventBusPublishQueueFullError);
    expect((refusal as EventBusPublishQueueFullError).details).toStrictEqual({
      key: "epoch",
      pending: 3,
      maxPending: 3,
    });
    expect(queue.pendingCount).toBe(3);
    expect(queue.maxPending).toBe(3);

    stall.resolve();
    await Promise.all(admitted);
    expect(queue.pendingCount).toBe(0);
  });

  it("frees the slot of a refused or failed operation", async () => {
    // A bound that only forgot successes would fill permanently on a stream of
    // failures, which would turn one transient fault into a dead publisher.
    const queue = new KeyedSerialQueue({ maxPending: 1 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        queue.run("epoch", async () => {
          throw new Error("refused");
        }),
      ).rejects.toThrow("refused");
      expect(queue.pendingCount).toBe(0);
    }

    await expect(queue.run("epoch", async () => "delivered")).resolves.toBe("delivered");
  });

  it("reports how long the longest-waiting operation has been waiting", async () => {
    const queue = new KeyedSerialQueue({ maxPending: 8 });
    expect(queue.oldestPendingAgeMs()).toBe(0);

    const stall = deferred<void>();
    const held = queue.run("epoch", async () => await stall.promise);
    const behind = queue.run("epoch", async () => undefined);
    await delay(30);

    // The waiter behind the stall is the one whose time would otherwise be
    // invisible; the oldest wait covers both.
    expect(queue.pendingCount).toBe(2);
    expect(queue.oldestPendingAgeMs()).toBeGreaterThanOrEqual(25);

    stall.resolve();
    await Promise.all([held, behind]);
    expect(queue.oldestPendingAgeMs()).toBe(0);
  });

  it("does not let one key's saturation stop another key from running", async () => {
    const queue = new KeyedSerialQueue({ maxPending: 2 });
    const stall = deferred<void>();
    const held = queue.run("epoch-a", async () => await stall.promise);
    const other = queue.run("epoch-b", async () => "ran");
    // Submitted while both of the above are still pending, so this is the one
    // past the shared bound.
    const beyondTheBound = queue.run("epoch-c", async () => undefined);

    // `epoch-b` was admitted and ran to completion while `epoch-a` was stalled:
    // the bound limits admission, it does not couple one epoch's execution to
    // another's.
    await expect(beyondTheBound).rejects.toBeInstanceOf(EventBusPublishQueueFullError);
    await expect(other).resolves.toBe("ran");

    // With `epoch-b` finished there is room again, and `epoch-a` is still stalled.
    await expect(queue.run("epoch-c", async () => "later")).resolves.toBe("later");

    stall.resolve();
    await held;
  });

  it("refuses a bound that is not a positive integer", () => {
    expect(() => new KeyedSerialQueue({ maxPending: 0 })).toThrow(EventBusConfigurationError);
    expect(() => new KeyedSerialQueue({ maxPending: 1.5 })).toThrow(EventBusConfigurationError);
  });
});
