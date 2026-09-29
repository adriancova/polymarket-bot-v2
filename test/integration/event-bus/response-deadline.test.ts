/**
 * `OUTAGE-1` — the response deadline (`RedisConnectionOptions.responseTimeoutMs`).
 *
 * `BOOT1-R7` measured the trader HANGING on a Redis outage. `ioredis` bounds
 * a command only when it SEES the fault (a close, then refused reconnections).
 * It does not bound a server that simply stops answering. The transport now
 * does: every command, every read beyond its own `waitMs`, the connection
 * handshake and the courtesy `QUIT` on close each have a deadline.
 *
 * The fault here is a FROZEN hop (`startFreezableRedisProxy`): sockets stay
 * open, new connections are accepted, and nothing is answered. That is what a
 * network partition or a paused server looks like to the client. It is
 * produced without touching the shared container, so every other file keeps
 * its server. The trader-level evidence, a real container stopped and a
 * partition under the real `startup()`, is in
 * `test/integration/paper-trader/redis-outage-halts-postgres-redis.test.ts`.
 *
 * Each claim is two-sided:
 * - the deadline FIRES when the server is silent, within the bound;
 * - it does NOT fire when the server is merely idle, including a blocking read
 *   whose own wait is longer than the bound, nor when it is slow or partitioned
 *   for LESS than the bound. The bound is the definition of an outage: an
 *   interruption the server answers within it is not one.
 *
 * `ioredis`'s own `blockingTimeout` was rejected for the blocking-read half,
 * on evidence: it RESOLVES the timed-out command with `null`, which an `XREAD`
 * caller reads as "no events", so a partition would look like an idle stream
 * forever. The transport's deadline REJECTS instead.
 */

import {
  EventBusConfigurationError,
  EventBusUnavailableError,
  RedisStreamsEventTransport,
} from "@polymarket-bot/event-bus";
import type { MarketEventTransport } from "@polymarket-bot/event-bus";
import {
  createTestEnvelopeSequence,
  pauseServerWrites,
  startFreezableRedisProxy,
  type FreezableRedisProxy,
} from "@polymarket-bot/event-bus/testing";
import { afterEach, describe, expect, inject, it } from "vitest";

import { captureRejection, connectTransport, publishAll, testStream } from "./context.js";

/** The bound under test: short, so a failure is quick and a pass is a measurement. */
const T = 400;
/** A connect bound short enough that the handshake deadline dominates the test's time. */
const CONNECT_T = 300;
/** Scheduling slack on every upper bound (a busy CI host). */
const MARGIN = 1_500;
/** How early a timer may observably fire relative to `performance.now()`. */
const EARLY = 50;

const opened: { transport?: MarketEventTransport; proxy?: FreezableRedisProxy }[] = [];

afterEach(async () => {
  for (const entry of opened.splice(0, opened.length)) {
    // Close the hop first: a transport closing through a frozen hop would wait
    // out its own QUIT bound for nothing.
    await entry.proxy?.close();
    await entry.transport?.close();
  }
});

/** A transport whose every connection goes through a hop this test can freeze. */
async function throughHop(): Promise<{ transport: MarketEventTransport; proxy: FreezableRedisProxy }> {
  const proxy = await startFreezableRedisProxy(inject("redisUrl"));
  const entry: { transport?: MarketEventTransport; proxy?: FreezableRedisProxy } = { proxy };
  opened.push(entry);
  const transport = await RedisStreamsEventTransport.connect({
    connection: { url: proxy.url, responseTimeoutMs: T, connectTimeoutMs: CONNECT_T },
    retention: { maxEvents: 100 },
  });
  entry.transport = transport;
  return { transport, proxy };
}

/** Runs an operation that must FAIL, returning how long it took and what it threw. */
async function timed(operation: () => Promise<unknown>): Promise<{ ms: number; error: unknown }> {
  const startedAt = performance.now();
  const error = await captureRejection(operation);
  return { ms: performance.now() - startedAt, error };
}

/** The error's cause chain, one message per link. */
function causes(error: unknown): string[] {
  const chain: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    chain.push(current.message);
    current = current.cause;
  }
  return chain;
}

describe("a server that stops answering fails the call within the bound (OUTAGE-1)", () => {
  it("a non-blocking receive fails with EventBusUnavailableError within T", async () => {
    const { transport, proxy } = await throughHop();
    const subscription = await transport.subscribe({ stream: testStream("deadline-poll"), consumerId: "trader" });
    expect((await subscription.receive({ maxEvents: 8 })).status).toBe("idle");

    proxy.freeze();
    const { ms, error } = await timed(async () => await subscription.receive({ maxEvents: 8 }));

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    expect(causes(error).join(" | ")).toContain(`no reply to a read within ${String(T)} ms`);
    expect(ms).toBeGreaterThanOrEqual(T - EARLY);
    expect(ms).toBeLessThanOrEqual(T + MARGIN);
  });

  it("a blocking receive is NOT cut short: it fails only after its own wait plus T", async () => {
    const { transport, proxy } = await throughHop();
    const subscription = await transport.subscribe({ stream: testStream("deadline-block"), consumerId: "trader" });
    const waitMs = 3 * T;

    proxy.freeze();
    const { ms, error } = await timed(async () => await subscription.receive({ maxEvents: 8, waitMs }));

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    expect(causes(error).join(" | ")).toContain(
      `no reply to a read within ${String(waitMs + T)} ms (its own ${String(waitMs)} ms wait`,
    );
    expect(ms).toBeGreaterThanOrEqual(waitMs + T - EARLY);
    expect(ms).toBeLessThanOrEqual(waitMs + T + MARGIN);
  });

  it("a publish fails with EventBusUnavailableError within T (the command connection's own timeout)", async () => {
    const { transport, proxy } = await throughHop();
    const stream = testStream("deadline-publish");
    const [first, second] = createTestEnvelopeSequence({ count: 2 });
    if (first === undefined || second === undefined) throw new Error("expected two envelopes");
    await transport.publish(stream, first);

    proxy.freeze();
    const { ms, error } = await timed(async () => await transport.publish(stream, second));

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    expect(causes(error)).toContain("Command timed out");
    expect(ms).toBeLessThanOrEqual(T + MARGIN);
  });

  it("a checkpoint fails with EventBusUnavailableError within T", async () => {
    const { transport, proxy } = await throughHop();
    const stream = testStream("deadline-checkpoint");
    await publishAll(transport, stream, createTestEnvelopeSequence({ count: 2 }));
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    const delivered = await subscription.receive({ maxEvents: 8 });
    if (delivered.status !== "events") throw new Error(`expected events, received ${delivered.status}`);
    const last = delivered.events.at(-1);
    if (last === undefined) throw new Error("expected a delivered event");

    proxy.freeze();
    const { ms, error } = await timed(async () => {
      await subscription.checkpoint(last.checkpoint);
    });

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    expect(ms).toBeLessThanOrEqual(T + MARGIN);
  });

  it("subscribing fails with EventBusUnavailableError instead of waiting on the silent server", async () => {
    const { transport, proxy } = await throughHop();
    proxy.freeze();
    const { ms, error } = await timed(
      async () => await transport.subscribe({ stream: testStream("deadline-subscribe"), consumerId: "trader" }),
    );

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    // The first step to meet the silent server fails; nothing after it runs.
    expect(ms).toBeLessThanOrEqual(CONNECT_T + T + MARGIN);
  });

  it("connecting to a server that accepts and never answers fails within the connect bound plus T", async () => {
    const proxy = await startFreezableRedisProxy(inject("redisUrl"));
    opened.push({ proxy });
    proxy.freeze();

    const { ms, error } = await timed(
      async () =>
        await RedisStreamsEventTransport.connect({
          connection: { url: proxy.url, responseTimeoutMs: T, connectTimeoutMs: CONNECT_T },
          retention: { maxEvents: 100 },
        }),
    );

    expect(error).toBeInstanceOf(EventBusUnavailableError);
    expect(ms).toBeLessThanOrEqual(CONNECT_T + T + MARGIN);
  });

  it("closing a transport whose server went silent returns within one bound per connection", async () => {
    const { transport, proxy } = await throughHop();
    const subscription = await transport.subscribe({ stream: testStream("deadline-close"), consumerId: "trader" });
    expect((await subscription.receive({ maxEvents: 8 })).status).toBe("idle");

    proxy.freeze();
    const startedAt = performance.now();
    await transport.close();
    const ms = performance.now() - startedAt;

    // Two connections (the command connection and the subscription's), each
    // offered one bounded QUIT; the subscriptions close before the command
    // connection does.
    expect(ms).toBeLessThanOrEqual(2 * T + MARGIN);
  });
});

describe("an idle server is not a silent one (OUTAGE-1: no false outage)", () => {
  it("a blocking read whose wait is LONGER than T returns idle, not a failure", async () => {
    const { transport } = await throughHop();
    const subscription = await transport.subscribe({ stream: testStream("idle-block"), consumerId: "trader" });
    const waitMs = 4 * T;

    const startedAt = performance.now();
    const result = await subscription.receive({ maxEvents: 8, waitMs });
    const ms = performance.now() - startedAt;

    expect(result.status).toBe("idle");
    // It genuinely waited: the server's own BLOCK ran out, not a deadline.
    expect(ms).toBeGreaterThanOrEqual(waitMs - EARLY);
  });

  it("non-blocking polls spread over five bounds all answer idle", async () => {
    const { transport } = await throughHop();
    const subscription = await transport.subscribe({ stream: testStream("idle-poll"), consumerId: "trader" });

    const until = performance.now() + 5 * T;
    let polls = 0;
    while (performance.now() < until) {
      const result = await subscription.receive({ maxEvents: 8 });
      expect(result.status).toBe("idle");
      polls += 1;
      await new Promise((resolve) => setTimeout(resolve, T / 4));
    }
    expect(polls).toBeGreaterThanOrEqual(5);
  });

  it("a SLOW server that still answers within T is not an outage: the publish waits and succeeds", async () => {
    const { transport } = await throughHop();
    const stream = testStream("slow-publish");
    const [first, second] = createTestEnvelopeSequence({ count: 2 });
    if (first === undefined || second === undefined) throw new Error("expected two envelopes");
    await transport.publish(stream, first);

    const stallMs = T / 2;
    await pauseServerWrites({ url: inject("redisUrl"), ms: stallMs });
    const startedAt = performance.now();
    const receipt = await transport.publish(stream, second);
    const ms = performance.now() - startedAt;

    expect(receipt.sequence).toBe(2);
    // It was genuinely slowed, and still answered inside the bound.
    expect(ms).toBeGreaterThanOrEqual(stallMs - 2 * EARLY);
  });

  it("a partition that HEALS within T is not an outage: the pending read answers once it heals", async () => {
    const { transport, proxy } = await throughHop();
    const stream = testStream("partition-heals");
    const publisher = await connectTransport({ maxEvents: 100 });
    const envelopes = createTestEnvelopeSequence({ count: 2 });
    await publishAll(publisher, stream, envelopes);
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });

    proxy.freeze();
    const pending = subscription.receive({ maxEvents: 8 });
    await new Promise((resolve) => setTimeout(resolve, T / 2));
    proxy.thaw();
    const result = await pending;

    if (result.status !== "events") throw new Error(`expected events, received ${result.status}`);
    expect(result.events.map((event) => event.envelope.eventId)).toStrictEqual(
      envelopes.map((envelope) => envelope.eventId),
    );
  });
});

describe("an abandoned read never moves the position (OUTAGE-1)", () => {
  it("a read that missed its deadline is dropped even if its reply comes later; the next read delivers from where the consumer was", async () => {
    const { transport, proxy } = await throughHop();
    const stream = testStream("deadline-late-reply");
    // Published directly, not through the hop, so the events exist whatever the hop does.
    const publisher = await connectTransport({ maxEvents: 100 });
    const envelopes = createTestEnvelopeSequence({ count: 3 });
    const subscription = await transport.subscribe({ stream, consumerId: "trader" });
    await publishAll(publisher, stream, envelopes);

    proxy.freeze();
    const abandoned = await timed(async () => await subscription.receive({ maxEvents: 8 }));
    expect(abandoned.error).toBeInstanceOf(EventBusUnavailableError);

    // The partition heals: the abandoned read's reply (all three events) now
    // arrives, and is dropped.
    proxy.thaw();
    const next = await subscription.receive({ maxEvents: 8 });
    if (next.status !== "events") throw new Error(`expected events, received ${next.status}`);
    expect(next.events.map((event) => event.envelope.eventId)).toStrictEqual(
      envelopes.map((envelope) => envelope.eventId),
    );
    expect((await subscription.metrics()).deliveredTotal).toBe(3);
  });
});

describe("the bound itself is validated before anything is opened (OUTAGE-1)", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 600_001])(
    "responseTimeoutMs %s is a configuration refusal, not a connection failure",
    async (responseTimeoutMs) => {
      // The URL is the shared server's: a refusal that happened AFTER a connect
      // would have succeeded in connecting first.
      const error = await captureRejection(
        async () =>
          await RedisStreamsEventTransport.connect({
            connection: { url: inject("redisUrl"), responseTimeoutMs },
            retention: { maxEvents: 100 },
          }),
      );
      expect(error).toBeInstanceOf(EventBusConfigurationError);
      expect((error as Error).message).toContain("responseTimeoutMs must be an integer in [1, 600000]");
    },
  );
});
