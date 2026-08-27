/**
 * Connection management for the Redis Streams implementation.
 *
 * This is the only file in the repository allowed to construct a Redis client
 * for market-event transport (`docs/contracts/dependency-direction.md` §3, F8;
 * ADR-003 §1). The client is created here rather than injected precisely
 * because an injected client would put `ioredis` types into the caller's
 * signature and hand the F8 grant to whoever calls us.
 *
 * ## Credentials
 *
 * There is no credential handling here and no environment lookup. The
 * composition root passes a URL; in this repository the only URL that exists is
 * a throwaway local container's (§0.2, ADR-010).
 */

import { Redis } from "ioredis";

import { EventBusConfigurationError, EventBusUnavailableError } from "../errors.js";
import {
  ENSURE_ORIGIN_SCRIPT,
  PUBLISH_SCRIPT,
  RESOLVE_POSITION_SCRIPT,
  STORE_CHECKPOINT_SCRIPT,
  STREAM_STATE_SCRIPT,
} from "./scripts.js";

export type RedisConnectionOptions = {
  /** Connection URL, for example `redis://127.0.0.1:6379`. */
  readonly url: string;
  /** Milliseconds to wait for the initial connection. Defaults to 10 000. */
  readonly connectTimeoutMs?: number;
  /**
   * Reconnection attempts a pending command rides out before failing.
   *
   * Defaults to 5. A brief reconnection is absorbed; a real outage surfaces as
   * {@link EventBusUnavailableError} rather than hanging, because ADR-003 §4
   * requires publication to *stop* on an outage — a caller blocked forever
   * would neither publish nor halt.
   */
  readonly maxRetriesPerRequest?: number;
};

/** The server-side scripts, as methods `defineCommand` installs. */
export type RedisScriptCommands = {
  ebPublish(
    streamKey: string,
    counterKey: string,
    retention: string,
    envelope: string,
  ): Promise<string[]>;
  ebStreamState(streamKey: string, counterKey: string, originKey: string): Promise<string[]>;
  ebEnsureOrigin(originKey: string, candidate: string): Promise<string[]>;
  ebResolvePosition(
    streamKey: string,
    counterKey: string,
    originKey: string,
    origin: string,
    entryId: string,
    sequence: string,
  ): Promise<string[]>;
  ebStoreCheckpoint(
    streamKey: string,
    counterKey: string,
    originKey: string,
    checkpointsKey: string,
    origin: string,
    entryId: string,
    sequence: string,
    consumerId: string,
    token: string,
  ): Promise<string[]>;
};

export type EventBusRedisClient = Redis & RedisScriptCommands;

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES_PER_REQUEST = 5;

/**
 * Creates and connects a client with both scripts installed.
 *
 * Every connection this package opens goes through here — including the
 * dedicated connection each subscription uses for blocking reads — so that no
 * connection can exist without the scripts, and so a blocking read can never
 * stall an unrelated command by sharing a socket with it.
 */
export async function createRedisClient(
  options: RedisConnectionOptions,
  connectionName: string,
): Promise<EventBusRedisClient> {
  assertUrl(options.url);

  const client = new Redis(options.url, {
    lazyConnect: true,
    connectTimeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? DEFAULT_MAX_RETRIES_PER_REQUEST,
    connectionName,
  });

  // Without a listener, ioredis's `error` event becomes an unhandled emitter
  // error and takes the process down on a reconnection blip. Swallowing it
  // here is safe because every command surfaces its own failure to its caller
  // as a typed error; nothing is hidden by not crashing.
  client.on("error", () => {});

  client.defineCommand("ebPublish", { numberOfKeys: 2, lua: PUBLISH_SCRIPT });
  client.defineCommand("ebStreamState", { numberOfKeys: 3, lua: STREAM_STATE_SCRIPT });
  client.defineCommand("ebEnsureOrigin", { numberOfKeys: 1, lua: ENSURE_ORIGIN_SCRIPT });
  client.defineCommand("ebResolvePosition", { numberOfKeys: 3, lua: RESOLVE_POSITION_SCRIPT });
  client.defineCommand("ebStoreCheckpoint", { numberOfKeys: 4, lua: STORE_CHECKPOINT_SCRIPT });

  try {
    await client.connect();
  } catch (cause) {
    client.disconnect();
    throw new EventBusUnavailableError(
      "could not connect to the event transport",
      { connectionName },
      cause,
    );
  }

  return client as EventBusRedisClient;
}

/** Closes a client, preferring a graceful quit but never hanging on one. */
export async function closeRedisClient(client: Redis): Promise<void> {
  try {
    await client.quit();
  } catch {
    // A quit against an already-broken connection is not a failure worth
    // propagating: the caller asked for the connection to go away, and
    // `disconnect` guarantees that regardless.
  } finally {
    client.disconnect();
  }
}

function assertUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EventBusConfigurationError("connection url is not a valid URL", { url });
  }
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") {
    throw new EventBusConfigurationError(
      "connection url must use the `redis:` or `rediss:` scheme",
      { protocol: parsed.protocol },
    );
  }
}
