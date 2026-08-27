/**
 * Checkpoint forgery, for tests that must prove a forgery is refused.
 *
 * Dev-only, and deliberately inside this package: the token format is private
 * to the Redis Streams implementation (`../redis/checkpoint.ts`), so a test that
 * hand-wrote one would either duplicate the format — and stop testing the real
 * thing the moment it changed — or would have to be given the codec, which is
 * exactly the boundary ADR-003's Consequences protect.
 *
 * A test importing this is stating "here is a token a consumer should never be
 * able to resume from". Nothing here is reachable from the package's main
 * entry point.
 */

import { decodeCheckpointToken, encodeCheckpointToken } from "../redis/checkpoint.js";
import type { StreamCheckpoint } from "../transport.js";

export type CheckpointTampering = {
  /** Replace the position's entry id. */
  readonly entryId?: string;
  /** Replace the position's publication ordinal. */
  readonly sequence?: number;
  /** Replace the stream instance marker the token claims. */
  readonly origin?: string;
  /** Replace the stream the checkpoint claims to belong to. */
  readonly stream?: string;
};

/** Rebuilds a checkpoint with parts of it replaced. */
export function tamperCheckpoint(
  checkpoint: StreamCheckpoint,
  tampering: CheckpointTampering,
): StreamCheckpoint {
  const position = decodeCheckpointToken(checkpoint.token);
  return {
    transport: checkpoint.transport,
    stream: tampering.stream ?? checkpoint.stream,
    token: encodeCheckpointToken(tampering.origin ?? position.origin, {
      entryId: tampering.entryId ?? position.entryId,
      sequence: tampering.sequence ?? position.sequence,
    }),
  };
}

/** The `(entry id, ordinal)` pair a checkpoint names, for assertions. */
export function readCheckpointPosition(checkpoint: StreamCheckpoint): {
  readonly origin: string;
  readonly entryId: string;
  readonly sequence: number;
} {
  return decodeCheckpointToken(checkpoint.token);
}
