import { describe, expect, it } from "vitest";

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
});
