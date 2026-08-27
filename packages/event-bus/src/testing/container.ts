/**
 * Testcontainers helper (handoff §16.4: "Use Testcontainers for PostgreSQL and
 * Redis").
 *
 * Dev-only. The image is pinned to the same version `docker-compose.yml` runs,
 * so an integration test exercises the server a developer runs locally rather
 * than a different major version with different stream semantics.
 *
 * CREDENTIALS: the container is throwaway, bound to a generated port, and lives
 * only for the test run. Nothing here reads, writes, or requires a real
 * credential (§0.2, ADR-010).
 */

import { randomBytes } from "node:crypto";

import { RedisContainer } from "@testcontainers/redis";
import type { StartedRedisContainer } from "@testcontainers/redis";

import { closeRedisClient, createRedisClient } from "../redis/client.js";
import { DEFAULT_KEY_PREFIX, streamKeys } from "../redis/keys.js";
import { FIELD_ENVELOPE, FIELD_SEQUENCE } from "../redis/scripts.js";

/** Pinned to `docker-compose.yml`'s Redis version. */
export const REDIS_TEST_IMAGE = "redis:7.4.2-alpine";

/** Starts a throwaway Redis container. */
export async function startRedisContainer(): Promise<StartedRedisContainer> {
  return await new RedisContainer(REDIS_TEST_IMAGE).start();
}

/**
 * A stream name no other test file can collide with.
 *
 * One container is shared by the whole run, so isolation comes from the name
 * rather than from a separate server: two files that both published to
 * `market` would interleave their publication ordinals and make every
 * continuity assertion meaningless.
 */
export function uniqueStreamName(label: string): string {
  const cleaned = label.replaceAll(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  const base = cleaned.length === 0 ? "stream" : cleaned;
  return `t-${base}-${randomBytes(5).toString("hex")}`;
}

export type FaultInjectionOptions = {
  readonly url: string;
  readonly stream: string;
  readonly keyPrefix?: string;
};

/**
 * Severs every other client connection.
 *
 * Simulates the network fault that a reconnection test needs, without stopping
 * the container — a restart would change the mapped port and test a different
 * thing (rediscovery) than the one that matters here (an established client
 * losing its socket).
 */
export async function killClientConnections(url: string): Promise<void> {
  const client = await createRedisClient({ url }, "pmb-event-bus-fault");
  try {
    await client.call("CLIENT", "KILL", "TYPE", "normal", "SKIPME", "yes");
  } finally {
    await closeRedisClient(client);
  }
}

/**
 * Appends an entry this transport did not write.
 *
 * It carries no publication ordinal, so it cannot be ordered or delivered. The
 * point of the test it enables is that the transport *reports* it instead of
 * stepping over it (§8.3).
 */
export async function injectForeignEntry(options: FaultInjectionOptions): Promise<void> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    await client.call("XADD", keys.events, "*", "written-by", "something-else");
  } finally {
    await closeRedisClient(client);
  }
}

/**
 * Appends an entry that looks like ours but whose body is not a §7.1 envelope.
 *
 * The publication counter is advanced with it, so the ordinals stay contiguous
 * and the consumer's failure is a decode failure rather than a spurious gap.
 */
export async function injectUnreadableEntry(
  options: FaultInjectionOptions & { readonly body?: string },
): Promise<void> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    const sequence = await client.incr(keys.published);
    await client.call(
      "XADD",
      keys.events,
      "*",
      FIELD_SEQUENCE,
      String(sequence),
      FIELD_ENVELOPE,
      options.body ?? "{ this is not an envelope",
    );
  } finally {
    await closeRedisClient(client);
  }
}
