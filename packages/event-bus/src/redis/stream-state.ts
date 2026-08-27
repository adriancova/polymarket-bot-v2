/**
 * Reading one atomic snapshot of a stream's state.
 *
 * Everything this package concludes about missing events comes from these five
 * numbers agreeing with each other, which is why they are read in one server-
 * side step (`./scripts.ts`) rather than assembled from separate replies.
 */

import { EventBusUnavailableError } from "../errors.js";
import type { EventBusRedisClient } from "./client.js";
import type { StreamKeys } from "./keys.js";

export type StreamState = {
  /** Total events ever published to this stream, including those retention removed. */
  readonly publishedTotal: number;
  /** Events retained right now. */
  readonly depth: number;
  /** Id of the oldest retained entry, absent when the stream retains nothing. */
  readonly firstEntryId: string | undefined;
  /** Publication ordinal of the oldest retained entry. */
  readonly firstSequence: number | undefined;
  /** Id of the newest retained entry, absent when the stream retains nothing. */
  readonly lastEntryId: string | undefined;
  /** The server's clock, so message age is not distorted by client clock skew. */
  readonly serverTimeMs: number;
  /** Publication time of the oldest retained entry, in server milliseconds. */
  readonly oldestEntryAtMs: number | undefined;
};

/** Runs the state script and parses its reply. */
export async function readStreamState(
  client: EventBusRedisClient,
  keys: StreamKeys,
): Promise<StreamState> {
  let reply: string[];
  try {
    reply = await client.ebStreamState(keys.events, keys.published);
  } catch (cause) {
    throw new EventBusUnavailableError(
      "could not read transport stream state",
      { stream: keys.events },
      cause,
    );
  }
  return parseStreamState(reply);
}

/** Parses the state script's reply. Exported for unit testing without a server. */
export function parseStreamState(reply: readonly string[]): StreamState {
  const publishedTotal = readCount(reply[0], "publishedTotal");
  const depth = readCount(reply[1], "depth");
  const firstEntryId = readOptionalString(reply[2]);
  const firstSequenceRaw = readOptionalString(reply[3]);
  const lastEntryId = readOptionalString(reply[4]);
  const seconds = readCount(reply[5], "serverSeconds");
  const microseconds = readCount(reply[6], "serverMicroseconds");

  return {
    publishedTotal,
    depth,
    firstEntryId,
    firstSequence:
      firstSequenceRaw === undefined ? undefined : readCount(firstSequenceRaw, "firstSequence"),
    lastEntryId,
    serverTimeMs: seconds * 1000 + Math.floor(microseconds / 1000),
    oldestEntryAtMs: firstEntryId === undefined ? undefined : entryIdTimestampMs(firstEntryId),
  };
}

/**
 * The publication time encoded in an entry id.
 *
 * Entry ids are `<serverMilliseconds>-<counter>`, so the oldest retained
 * entry's age needs no extra stored field. Returns `undefined` rather than
 * guessing if the id is not in that shape.
 */
export function entryIdTimestampMs(entryId: string): number | undefined {
  const separator = entryId.indexOf("-");
  const millis = Number(separator === -1 ? entryId : entryId.slice(0, separator));
  return Number.isSafeInteger(millis) && millis >= 0 ? millis : undefined;
}

function readOptionalString(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function readCount(value: string | undefined, field: string): number {
  if (value === undefined) {
    throw new EventBusUnavailableError(`transport stream state is missing \`${field}\``, { field });
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EventBusUnavailableError(
      `transport stream state field \`${field}\` is not a non-negative safe integer`,
      { field, value },
    );
  }
  return parsed;
}
