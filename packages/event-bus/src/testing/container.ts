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
import { createConnection, createServer } from "node:net";
import type { Socket } from "node:net";

import { RedisContainer } from "@testcontainers/redis";
import type { StartedRedisContainer } from "@testcontainers/redis";

import type { EventEnvelope } from "@polymarket-bot/domain";

import { encodeEnvelope } from "../envelope-codec.js";
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
 * Puts a value of the wrong type where one of a stream's keys belongs.
 *
 * The fault a publish must survive without cost: the append or the counter
 * write fails, and the test it enables asserts that no publication ordinal was
 * consumed for the event that never landed.
 */
export async function occupyKeyWithWrongType(
  options: FaultInjectionOptions & { readonly which: "events" | "published" | "checkpoints" },
): Promise<void> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    if (options.which === "events") {
      await client.set(keys.events, "this is not a stream");
    } else if (options.which === "checkpoints") {
      await client.set(keys.checkpoints, "this is not a position hash");
    } else {
      await client.lpush(keys.published, "this is not a counter");
    }
  } finally {
    await closeRedisClient(client);
  }
}

/**
 * Replaces this stream instance's marker with another well-formed one.
 *
 * What an operator restoring a namespace from elsewhere leaves behind: the
 * stream and its counter are intact, but every position taken before now
 * belongs to an instance that is no longer the one here.
 */
export async function overwriteStreamOrigin(
  options: FaultInjectionOptions & { readonly origin?: string },
): Promise<string> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const replacement = options.origin ?? randomBytes(16).toString("hex");
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    await client.set(keys.origin, replacement);
    return replacement;
  } finally {
    await closeRedisClient(client);
  }
}

/** Removes whichever of a stream's keys a test names, leaving the rest. */
export async function removeStreamKeys(
  options: FaultInjectionOptions & {
    readonly which: readonly ("events" | "published" | "checkpoints" | "origin")[];
  },
): Promise<void> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    await client.del(...options.which.map((key) => keys[key]));
  } finally {
    await closeRedisClient(client);
  }
}

/** Sets the publication counter directly, for the safe-integer ceiling case. */
export async function setPublicationCounter(
  options: FaultInjectionOptions & { readonly value: string },
): Promise<void> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    await client.set(keys.published, options.value);
  } finally {
    await closeRedisClient(client);
  }
}

/**
 * Reads the raw publication counter and retained depth, bypassing the transport.
 *
 * Both are `undefined` when the key does not hold what it should, so a test can
 * assert "nothing was written" against a key a fault deliberately occupied.
 */
export async function readRawStreamState(
  options: FaultInjectionOptions,
): Promise<{ readonly published: string | undefined; readonly depth: number | undefined }> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    const counterType = await client.type(keys.published);
    const published =
      counterType === "string" ? ((await client.get(keys.published)) ?? undefined) : undefined;
    const streamType = await client.type(keys.events);
    const depth = streamType === "stream" ? await client.xlen(keys.events) : undefined;
    return { published, depth };
  } finally {
    await closeRedisClient(client);
  }
}

/** Writes a raw value into a consumer's stored position. */
export async function writeStoredCheckpoint(
  options: FaultInjectionOptions & { readonly consumerId: string; readonly token: string },
): Promise<void> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    await client.hset(keys.checkpoints, options.consumerId, options.token);
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

/**
 * Appends a well-formed entry at an id the test chooses.
 *
 * What it exists for: an entry whose id is ahead of the server's clock is what a
 * server clock stepping *backwards* leaves behind — a genuine, retained,
 * correctly numbered entry that a naive future-id guard would refuse. Injecting
 * the id directly reproduces that state without touching any clock.
 */
export async function injectEntryWithId(
  options: FaultInjectionOptions & {
    readonly entryId: string;
    readonly envelope: EventEnvelope<unknown>;
  },
): Promise<{ readonly entryId: string; readonly sequence: number }> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    const sequence = await client.incr(keys.published);
    await client.call(
      "XADD",
      keys.events,
      options.entryId,
      FIELD_SEQUENCE,
      String(sequence),
      FIELD_ENVELOPE,
      encodeEnvelope(options.envelope),
    );
    return { entryId: options.entryId, sequence };
  } finally {
    await closeRedisClient(client);
  }
}

/** One retained entry, exactly as the server holds it. */
export type RawStreamEntry = {
  readonly id: string;
  readonly fields: readonly string[];
};

/**
 * Reads every retained entry verbatim.
 *
 * A test that must prove a failed publish left the stream "exactly as found"
 * cannot do it with a length: a bounded stream at its retention bound stays the
 * same length while losing its oldest entry. Comparing contents is the only
 * comparison that catches that.
 */
export async function readRawStreamEntries(
  options: FaultInjectionOptions,
): Promise<readonly RawStreamEntry[]> {
  const keys = streamKeys(options.keyPrefix ?? DEFAULT_KEY_PREFIX, options.stream);
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    const reply = (await client.call("XRANGE", keys.events, "-", "+")) as [string, string[]][];
    return reply.map(([id, fields]) => ({ id, fields: [...fields] }));
  } finally {
    await closeRedisClient(client);
  }
}

/**
 * Stops the server from serving writes for a while, then lets them through.
 *
 * The fault a bounded producer queue has to be tested against: the connection
 * is alive, the publish that owns it never returns, and everything submitted
 * behind it waits. Nothing is killed, so the stall ends cleanly.
 */
export async function pauseServerWrites(
  options: { readonly url: string; readonly ms: number },
): Promise<void> {
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    await client.call("CLIENT", "PAUSE", String(options.ms), "WRITE");
  } finally {
    await closeRedisClient(client);
  }
}

/** Ends a pause early, so a finished test cannot leak a stall into the next one. */
export async function resumeServerWrites(url: string): Promise<void> {
  const client = await createRedisClient({ url }, "pmb-event-bus-fault");
  try {
    await client.call("CLIENT", "UNPAUSE");
  } finally {
    await closeRedisClient(client);
  }
}

/** A local hop in front of the test server that a test can take away. */
export type RedisProxy = {
  /** Connect through this instead of the container's own URL. */
  readonly url: string;
  /** Destroys every connection and stops accepting new ones. */
  close(): Promise<void>;
};

/**
 * Puts a local TCP hop in front of the test server.
 *
 * Severing connections is not the same fault as losing the server: `ioredis`
 * reconnects, and a command in flight when a connection dies usually succeeds
 * on the next one — which is exactly what `reconnect.test.ts` asserts. A test
 * that needs a command to *fail* needs somewhere for the reconnection to fail
 * too, and closing this hop provides it without stopping the shared container
 * that every other test in the run depends on.
 */
export async function startRedisProxy(targetUrl: string): Promise<RedisProxy> {
  const target = new URL(targetUrl);
  const targetHost = target.hostname;
  const targetPort = Number(target.port);
  const open = new Set<Socket>();

  const server = createServer((incoming: Socket) => {
    const upstream = createConnection({ host: targetHost, port: targetPort });
    open.add(incoming);
    open.add(upstream);
    const drop = (): void => {
      open.delete(incoming);
      open.delete(upstream);
      incoming.destroy();
      upstream.destroy();
    };
    // A destroyed socket emits `error`; without a listener that becomes an
    // unhandled emitter error and takes the test run down.
    incoming.on("error", drop);
    upstream.on("error", drop);
    incoming.on("close", drop);
    upstream.on("close", drop);
    incoming.pipe(upstream);
    upstream.pipe(incoming);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the proxy did not bind to a port");
  }

  return {
    url: `redis://127.0.0.1:${String(address.port)}`,
    close: async () => {
      for (const socket of [...open]) {
        socket.destroy();
      }
      open.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/**
 * A connection URL for a throwaway account that may not run some commands.
 *
 * CREDENTIALS: the account exists only inside the throwaway test container, its
 * secret is generated here and never leaves this process, and it grants nothing
 * anywhere else. It is test scaffolding, not a credential (§0.2, ADR-010).
 *
 * It exists because a command-specific denial is the reachable way to make one
 * step of a server-side script fail while the steps around it succeed — which is
 * the only way to test what a partially applied publish leaves behind.
 */
export async function createCommandDeniedUrl(options: {
  readonly url: string;
  readonly deny: readonly string[];
}): Promise<string> {
  const username = `pmb-fault-${randomBytes(6).toString("hex")}`;
  const secret = randomBytes(24).toString("hex");
  const client = await createRedisClient({ url: options.url }, "pmb-event-bus-fault");
  try {
    await client.call(
      "ACL",
      "SETUSER",
      username,
      "on",
      `>${secret}`,
      "~*",
      "&*",
      "+@all",
      ...options.deny.map((command) => `-${command}`),
    );
  } finally {
    await closeRedisClient(client);
  }
  const parsed = new URL(options.url);
  parsed.username = username;
  parsed.password = secret;
  return parsed.toString();
}
