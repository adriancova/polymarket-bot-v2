/**
 * Checkpoint tokens for the Redis Streams implementation.
 *
 * A token names two things: the entry id delivery resumes after, and that
 * entry's publication ordinal (`../resync.ts`). Both are needed — the id is how
 * the next read is positioned, the ordinal is how a gap is detected — and
 * keeping them in one token is what makes a checkpoint a single value a
 * consumer can store next to its own state.
 *
 * The encoding is versioned (`ebc1`) so a future implementation can recognise
 * and reject a token it did not mint rather than misread one.
 *
 * **This format is private to this implementation.** `StreamCheckpoint.token`
 * is opaque at the interface (ADR-003 Consequences), and nothing outside this
 * directory parses it.
 */

import { EventBusCheckpointError } from "../errors.js";
import type { EventStreamName, StreamCheckpoint, TransportId } from "../transport.js";

/** Versioned token prefix. */
export const CHECKPOINT_TOKEN_VERSION = "ebc1";

const TOKEN_PATTERN = /^ebc1:(\d+-\d+):(0|[1-9][0-9]*)$/u;

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

/** The position at the very beginning of a stream: nothing consumed yet. */
export const STREAM_ORIGIN_ENTRY_ID = "0-0";

export function encodeCheckpointToken(position: StreamPosition): string {
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
  return `${CHECKPOINT_TOKEN_VERSION}:${position.entryId}:${String(position.sequence)}`;
}

export function decodeCheckpointToken(token: string): StreamPosition {
  const match = TOKEN_PATTERN.exec(token);
  if (match === null) {
    throw new EventBusCheckpointError("checkpoint token is not a token this transport issued", {
      token,
    });
  }
  const entryId = match[1];
  const rawSequence = match[2];
  if (entryId === undefined || rawSequence === undefined) {
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
  return { entryId, sequence };
}

/** Mints a checkpoint for a position. */
export function createCheckpoint(
  transport: TransportId,
  stream: EventStreamName,
  position: StreamPosition,
): StreamCheckpoint {
  return { transport, stream, token: encodeCheckpointToken(position) };
}

/**
 * Reads a checkpoint back, refusing one that belongs somewhere else.
 *
 * A token from another stream or another transport would decode into a
 * plausible-looking position and silently resume from the wrong place, so both
 * are checked before the token is even parsed.
 */
export function readCheckpoint(
  transport: TransportId,
  stream: EventStreamName,
  checkpoint: StreamCheckpoint,
): StreamPosition {
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
