/**
 * Checkpoint tokens for the Redis Streams implementation.
 *
 * A token names three things: the stream instance it was minted against, the
 * entry id delivery resumes after, and that entry's publication ordinal
 * (`../resync.ts`). All three are needed — the marker is how a token from
 * somewhere else is recognised, the id is how the next read is positioned, the
 * ordinal is how a gap is detected — and keeping them in one value is what makes
 * a checkpoint a single thing a consumer can store next to its own state.
 *
 * ## Syntax is not identity
 *
 * Decoding a token proves only that it has this implementation's shape. It does
 * **not** prove that the position exists, that it belongs to this server, or
 * that the id and the ordinal describe the same entry — and a position that
 * fails any of those would still resume delivery *somewhere*, skipping whatever
 * lay between silently. So a decoded token is a claim, and every path that acts
 * on one has the server judge it first (`./scripts.ts`,
 * `RESOLVE_POSITION_SCRIPT`). Nothing in this package starts reading, or stores
 * a position, on the strength of a token's format alone.
 *
 * The marker is not a secret and this is not authentication: a caller holding a
 * genuine token can still choose to resume at the position it names. What the
 * marker removes is the *silent* case — a token from another server, another
 * key namespace, or a stream that was destroyed and recreated no longer decodes
 * into a plausible position here, and an id that names no entry is refused
 * rather than believed.
 *
 * The encoding is versioned (`ebc2`) so a future implementation can recognise
 * and reject a token it did not mint rather than misread one.
 *
 * **This format is private to this implementation.** `StreamCheckpoint.token`
 * is opaque at the interface (ADR-003 Consequences), and nothing outside this
 * directory parses it.
 */

import { EventBusCheckpointError } from "../errors.js";
import type { EventStreamName, StreamCheckpoint, TransportId } from "../transport.js";

/** Versioned token prefix. */
export const CHECKPOINT_TOKEN_VERSION = "ebc2";

/** Length of a stream instance marker, in hex characters. */
export const STREAM_ORIGIN_LENGTH = 32;

const TOKEN_PATTERN = /^ebc2:([0-9a-f]{32}):(\d+-\d+):(0|[1-9][0-9]*)$/u;

const ORIGIN_PATTERN = /^[0-9a-f]{32}$/u;

/**
 * The position a consumer resumes from.
 *
 * `entryId` is the id of the last consumed entry — the next read starts
 * strictly after it. `sequence` is that entry's publication ordinal.
 */
export type StreamPosition = {
  readonly entryId: string;
  readonly sequence: number;
};

/** A position together with the stream instance it was taken in. */
export type BoundStreamPosition = StreamPosition & {
  /** The instance marker the position belongs to. */
  readonly origin: string;
};

/** The position at the very beginning of a stream: nothing consumed yet. */
export const STREAM_ORIGIN_ENTRY_ID = "0-0";

/** Validates a stream instance marker, so a malformed one cannot enter a token. */
export function assertStreamOrigin(origin: string): void {
  if (!ORIGIN_PATTERN.test(origin)) {
    throw new EventBusCheckpointError(
      "the stream instance marker is not a value this transport mints",
      { origin },
    );
  }
}

export function encodeCheckpointToken(origin: string, position: StreamPosition): string {
  assertStreamOrigin(origin);
  if (!/^\d+-\d+$/u.test(position.entryId)) {
    throw new EventBusCheckpointError("checkpoint position has a malformed entry id", {
      entryId: position.entryId,
    });
  }
  if (!Number.isSafeInteger(position.sequence) || position.sequence < 0) {
    throw new EventBusCheckpointError(
      "checkpoint position sequence must be a non-negative safe integer",
      { sequence: position.sequence },
    );
  }
  return `${CHECKPOINT_TOKEN_VERSION}:${origin}:${position.entryId}:${String(position.sequence)}`;
}

export function decodeCheckpointToken(token: string): BoundStreamPosition {
  const match = TOKEN_PATTERN.exec(token);
  if (match === null) {
    throw new EventBusCheckpointError("checkpoint token is not a token this transport issued", {
      token,
    });
  }
  const origin = match[1];
  const entryId = match[2];
  const rawSequence = match[3];
  if (origin === undefined || entryId === undefined || rawSequence === undefined) {
    throw new EventBusCheckpointError("checkpoint token is not a token this transport issued", {
      token,
    });
  }
  const sequence = Number(rawSequence);
  if (!Number.isSafeInteger(sequence)) {
    throw new EventBusCheckpointError(
      "checkpoint token carries a publication ordinal larger than this process can represent exactly",
      { token },
    );
  }
  return { origin, entryId, sequence };
}

/** Mints a checkpoint for a position in one stream instance. */
export function createCheckpoint(
  transport: TransportId,
  stream: EventStreamName,
  origin: string,
  position: StreamPosition,
): StreamCheckpoint {
  return { transport, stream, token: encodeCheckpointToken(origin, position) };
}

/**
 * Reads a checkpoint back, refusing one that belongs somewhere else.
 *
 * A token from another stream or another transport would decode into a
 * plausible-looking position and silently resume from the wrong place, so both
 * are checked before the token is even parsed. What this function cannot check
 * is whether the position *exists*: that is the server's job, and every caller
 * of this function hands the result to it before reading or storing anything.
 */
export function readCheckpoint(
  transport: TransportId,
  stream: EventStreamName,
  checkpoint: StreamCheckpoint,
): BoundStreamPosition {
  if (checkpoint.transport !== transport) {
    throw new EventBusCheckpointError(
      `checkpoint was issued by transport \`${checkpoint.transport}\`, not \`${transport}\``,
      { expected: transport, received: checkpoint.transport },
    );
  }
  if (checkpoint.stream !== stream) {
    throw new EventBusCheckpointError(
      `checkpoint belongs to stream \`${checkpoint.stream}\`, not \`${stream}\``,
      { expected: stream, received: checkpoint.stream },
    );
  }
  return decodeCheckpointToken(checkpoint.token);
}
