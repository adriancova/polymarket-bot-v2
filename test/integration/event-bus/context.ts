/**
 * Per-file transport setup for the integration suite.
 *
 * Every transport a test creates is registered and closed in `afterEach`, so a
 * failing assertion cannot leave a blocking read holding a connection into the
 * next test. Stream names are unique per test, so two files sharing the one
 * container can never interleave their publication ordinals — which would make
 * every continuity assertion in this suite meaningless.
 */

import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import type {
  EventSubscription,
  MarketEventTransport,
  RetentionPolicy,
  SubscribeOptions,
} from "@polymarket-bot/event-bus";
import { uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import type { EventEnvelope } from "@polymarket-bot/domain";
import { afterEach, inject } from "vitest";

const openTransports: MarketEventTransport[] = [];

afterEach(async () => {
  const transports = openTransports.splice(0, openTransports.length);
  for (const transport of transports) {
    await transport.close();
  }
});

/** Connects a transport that the suite closes after the current test. */
export async function connectTransport(
  retention: RetentionPolicy,
): Promise<MarketEventTransport> {
  const transport = await RedisStreamsEventTransport.connect({
    connection: { url: inject("redisUrl") },
    retention,
  });
  openTransports.push(transport);
  return transport;
}

/** A stream name no other test uses. */
export function testStream(label: string): string {
  return uniqueStreamName(label);
}

/** Publishes envelopes in order, one at a time, as a sequential producer does. */
export async function publishAll(
  transport: MarketEventTransport,
  stream: string,
  envelopes: readonly EventEnvelope<unknown>[],
): Promise<void> {
  for (const envelope of envelopes) {
    await transport.publish(stream, envelope);
  }
}

/**
 * Drains a subscription until it goes idle.
 *
 * Returns the delivered envelopes plus the last checkpoint offered, so a test
 * can assert order and then resume from a real position.
 */
export async function drain(
  subscription: EventSubscription,
  options: { readonly maxBatches?: number } = {},
): Promise<{
  readonly envelopes: EventEnvelope<unknown>[];
  readonly lastCheckpoint: ReturnType<EventSubscription["lastCheckpoint"]>;
}> {
  const envelopes: EventEnvelope<unknown>[] = [];
  let lastCheckpoint = subscription.lastCheckpoint();
  const maxBatches = options.maxBatches ?? 100;

  for (let batch = 0; batch < maxBatches; batch += 1) {
    const result = await subscription.receive({ maxEvents: 16 });
    if (result.status !== "events") {
      break;
    }
    for (const event of result.events) {
      envelopes.push(event.envelope);
      lastCheckpoint = event.checkpoint;
    }
  }

  return { envelopes, lastCheckpoint };
}

/** Asserts that `operation` fails, and returns the failure for inspection. */
export async function captureRejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to be rejected, but it succeeded.");
}

/** The `subscribe` options for a consumer resuming its own stored checkpoint. */
export function resumeStored(stream: string, consumerId: string): SubscribeOptions {
  return { stream, consumerId, start: { at: "stored-checkpoint", whenMissing: "oldest-retained" } };
}
