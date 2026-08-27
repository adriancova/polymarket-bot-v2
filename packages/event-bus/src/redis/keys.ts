/**
 * Key layout for the Redis Streams implementation.
 *
 * Three keys per logical stream:
 *
 * | Key | Holds |
 * | --- | --- |
 * | `…{name}:events` | the bounded stream of published envelopes |
 * | `…{name}:published` | the contiguous publication counter (see `../resync.ts`) |
 * | `…{name}:checkpoints` | one durable position per consumer id |
 *
 * The `{name}` braces are a Redis Cluster hash tag: they force all three keys of
 * one logical stream into the same slot, which is what lets the publish and
 * state scripts touch them together. They cost nothing on a standalone server.
 *
 * None of this is visible through `../transport.ts` — a caller names a logical
 * stream and never sees a key.
 */

import { EventBusConfigurationError } from "../errors.js";
import type { EventStreamName } from "../transport.js";

/** Default key namespace: `pmb` for the project, `events` for this package. */
export const DEFAULT_KEY_PREFIX = "pmb:events";

/** Upper bound on a stream name, matching the domain's identifier bound. */
export const MAX_STREAM_NAME_LENGTH = 200;

const STREAM_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;
const KEY_PREFIX_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;

export type StreamKeys = {
  readonly events: string;
  readonly published: string;
  readonly checkpoints: string;
};

/**
 * Validates a logical stream name.
 *
 * Restricted to the same vocabulary the domain uses for codes and channels: an
 * unrestricted name would let a caller inject a `{`, a space, or a newline into
 * a key and quietly address a different stream than it named.
 */
export function assertStreamName(stream: EventStreamName): void {
  if (stream.length === 0 || stream.length > MAX_STREAM_NAME_LENGTH) {
    throw new EventBusConfigurationError(
      `stream name must be 1..${String(MAX_STREAM_NAME_LENGTH)} characters`,
      { stream },
    );
  }
  if (!STREAM_NAME_PATTERN.test(stream)) {
    throw new EventBusConfigurationError(
      "stream name must start with a letter and contain only letters, digits, and `_.:-`",
      { stream },
    );
  }
}

/** Validates a key namespace with the same rules as a stream name. */
export function assertKeyPrefix(prefix: string): void {
  if (prefix.length === 0 || prefix.length > MAX_STREAM_NAME_LENGTH) {
    throw new EventBusConfigurationError(
      `key prefix must be 1..${String(MAX_STREAM_NAME_LENGTH)} characters`,
      { prefix },
    );
  }
  if (!KEY_PREFIX_PATTERN.test(prefix)) {
    throw new EventBusConfigurationError(
      "key prefix must start with a letter and contain only letters, digits, and `_.:-`",
      { prefix },
    );
  }
}

/** Builds the three keys for one logical stream. */
export function streamKeys(prefix: string, stream: EventStreamName): StreamKeys {
  assertKeyPrefix(prefix);
  assertStreamName(stream);
  const base = `${prefix}:{${stream}}`;
  return {
    events: `${base}:events`,
    published: `${base}:published`,
    checkpoints: `${base}:checkpoints`,
  };
}

/**
 * Validates a consumer id.
 *
 * It becomes a field name in the checkpoint hash, and it labels metrics, so it
 * gets the same bounded vocabulary as a stream name.
 */
export function assertConsumerId(consumerId: string): void {
  if (consumerId.length === 0 || consumerId.length > MAX_STREAM_NAME_LENGTH) {
    throw new EventBusConfigurationError(
      `consumer id must be 1..${String(MAX_STREAM_NAME_LENGTH)} characters`,
      { consumerId },
    );
  }
  if (!STREAM_NAME_PATTERN.test(consumerId)) {
    throw new EventBusConfigurationError(
      "consumer id must start with a letter and contain only letters, digits, and `_.:-`",
      { consumerId },
    );
  }
}
