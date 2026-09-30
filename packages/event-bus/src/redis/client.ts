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
import { withDeadline } from "./deadline.js";
import {
  ENSURE_ORIGIN_SCRIPT,
  PUBLISH_BATCH_SCRIPT,
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
   *
   * Dated correction (`OUTAGE-1`): "rather than hanging" held only for an
   * outage whose every reconnection is REFUSED. A command in flight when the
   * connection drops, followed by reconnections that are accepted and then
   * die, is never reached by this retry flush. `responseTimeoutMs` below is
   * the bound that holds in that case.
   */
  readonly maxRetriesPerRequest?: number;
  /**
   * How long one command may go unanswered before the transport treats the
   * server as unreachable and fails the call with
   * {@link EventBusUnavailableError}. Defaults to
   * {@link DEFAULT_RESPONSE_TIMEOUT_MS} (5 000); an integer in
   * [1, {@link MAX_RESPONSE_TIMEOUT_MS}].
   *
   * `maxRetriesPerRequest` alone does NOT bound a command (`OUTAGE-1`,
   * `BOOT1-R7`, measured). When the server goes away and reconnections are
   * accepted and then dropped mid-handshake, the command that was in flight
   * is parked in `ioredis`'s resend-on-reconnect queue, which its retry
   * flush never touches. A trader awaiting it then hangs instead of halting.
   * This deadline is what turns that outage into a failure the caller's halt
   * path can act on. It applies:
   *
   * - on the COMMAND connection, to every command (`ioredis`'s own
   *   `commandTimeout`: nothing on that connection blocks, so a command that
   *   has not answered in this long is a server that is not answering);
   * - on a subscription's BLOCKING-READ connection, to each read, as the
   *   read's own `waitMs` PLUS this bound (`./subscription.ts`), so a read
   *   that is legitimately waiting for events is never cut short;
   * - to the initial connection's handshake, after `connectTimeoutMs` has
   *   bounded the TCP connect;
   * - to the courtesy `QUIT` on close, which is sent only to a connection
   *   that is ready (see {@link closeRedisClient}).
   *
   * The default is seconds because a healthy server answers these commands
   * in well under a millisecond: 5 s is thousands of times the normal
   * latency, which absorbs a garbage-collection pause or a brief reconnect,
   * yet stays short enough that a process waiting on a dead transport halts
   * in seconds rather than looking alive while deciding nothing.
   */
  readonly responseTimeoutMs?: number;
};

/** What a connection carries — which decides where its response deadline is enforced. */
export type RedisConnectionRole =
  /** Non-blocking commands only: `ioredis`'s per-command timeout is installed. */
  | "commands"
  /**
   * `XREAD … BLOCK`: a per-command timeout would cut a legitimate wait short,
   * so the reader races each read against its own deadline instead.
   */
  | "blocking-reads";

/** The server-side scripts, as methods `defineCommand` installs. */
export type RedisScriptCommands = {
  ebPublish(
    streamKey: string,
    counterKey: string,
    retention: string,
    envelope: string,
  ): Promise<string[]>;
  /** `PUBLISH_BATCH_SCRIPT`: the envelopes follow the retention bound, in order. */
  ebPublishBatch(
    streamKey: string,
    counterKey: string,
    retention: string,
    ...envelopes: string[]
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

/** The default {@link RedisConnectionOptions.responseTimeoutMs}. See its note for why 5 s. */
export const DEFAULT_RESPONSE_TIMEOUT_MS = 5_000;

/** The largest accepted {@link RedisConnectionOptions.responseTimeoutMs}: ten minutes. */
export const MAX_RESPONSE_TIMEOUT_MS = 600_000;

/**
 * The response bound these options select, validated.
 *
 * Refused rather than clamped: a bound the caller did not choose is a bound
 * nobody chose.
 */
export function resolveResponseTimeoutMs(options: RedisConnectionOptions): number {
  const value = options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_RESPONSE_TIMEOUT_MS) {
    throw new EventBusConfigurationError(
      `responseTimeoutMs must be an integer in [1, ${String(MAX_RESPONSE_TIMEOUT_MS)}], received ` +
        String(value),
      { responseTimeoutMs: value },
    );
  }
  return value;
}

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
  role: RedisConnectionRole = "commands",
): Promise<EventBusRedisClient> {
  assertUrl(options.url);
  const responseTimeoutMs = resolveResponseTimeoutMs(options);
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  const client = new Redis(options.url, {
    lazyConnect: true,
    connectTimeout: connectTimeoutMs,
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? DEFAULT_MAX_RETRIES_PER_REQUEST,
    connectionName,
    // The timer is on the command object, so it fires even for a command
    // `ioredis` has parked in its resend-on-reconnect queue — the case its
    // own retry flush misses (see `responseTimeoutMs`).
    commandTimeout: role === "commands" ? responseTimeoutMs : undefined,
  });

  // Without a listener, ioredis's `error` event becomes an unhandled emitter
  // error and takes the process down on a reconnection blip. Swallowing it
  // here is safe because every command surfaces its own failure to its caller
  // as a typed error; nothing is hidden by not crashing.
  client.on("error", () => {});

  client.defineCommand("ebPublish", { numberOfKeys: 2, lua: PUBLISH_SCRIPT });
  client.defineCommand("ebPublishBatch", { numberOfKeys: 2, lua: PUBLISH_BATCH_SCRIPT });
  client.defineCommand("ebStreamState", { numberOfKeys: 3, lua: STREAM_STATE_SCRIPT });
  client.defineCommand("ebEnsureOrigin", { numberOfKeys: 1, lua: ENSURE_ORIGIN_SCRIPT });
  client.defineCommand("ebResolvePosition", { numberOfKeys: 3, lua: RESOLVE_POSITION_SCRIPT });
  client.defineCommand("ebStoreCheckpoint", { numberOfKeys: 4, lua: STORE_CHECKPOINT_SCRIPT });

  try {
    // `connectTimeout` bounds only the TCP connect. A server that accepts and
    // then never completes the handshake would otherwise hold this await
    // open indefinitely, so the whole connection is bounded here.
    await withDeadline(
      client.connect(),
      connectTimeoutMs + responseTimeoutMs,
      () =>
        new Error(
          `no ready connection within ${String(connectTimeoutMs + responseTimeoutMs)} ms ` +
            `(the ${String(connectTimeoutMs)} ms connect bound plus the ` +
            `${String(responseTimeoutMs)} ms response bound for the handshake)`,
        ),
    );
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

/**
 * Closes a client, preferring a graceful quit but never hanging on one.
 *
 * The `QUIT` is a courtesy to a server that is answering, so it is sent only
 * to a connection that is `ready`, and it is bounded by `quitTimeoutMs`. To a
 * connection that is reconnecting or stuck mid-handshake, `ioredis` would
 * QUEUE the quit behind whatever it still holds. A close issued because the
 * server went away would then wait on the very outage it is closing for,
 * which is what `OUTAGE-1` measured before this bound existed.
 */
export async function closeRedisClient(
  client: Redis,
  quitTimeoutMs: number = DEFAULT_RESPONSE_TIMEOUT_MS,
): Promise<void> {
  try {
    if (client.status === "ready") {
      await withDeadline(
        client.quit(),
        quitTimeoutMs,
        () => new Error(`QUIT was not answered within ${String(quitTimeoutMs)} ms`),
      );
    }
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
