/**
 * Server-judged checkpoint positions.
 *
 * ADR-003 §3.3 forbids "silent catch-up from an incomplete stream", and ADR-003
 * §3.4 requires a restart to resume "from a known position within retention".
 * A token that merely *parses* satisfies neither: an id in the future, an id
 * that names no entry, an id paired with the wrong ordinal, or a token minted
 * against another server or key namespace all decode into a position delivery
 * would happily start from — and everything between the consumer's real
 * position and that one would be skipped without a word.
 *
 * So this module is the boundary where a claim becomes a position: every path
 * that starts reading, or records a position durably, sends `(marker, entry id,
 * ordinal)` to the server, which judges it against the stream it actually holds
 * (`./scripts.ts`). An accepted verdict names a position the stream holds or
 * held; every refusal is a typed error naming which of those it failed.
 */

import { randomBytes } from "node:crypto";

import { EventBusCheckpointError, EventBusUnavailableError } from "../errors.js";
import type { ConsumerId, EventStreamName } from "../transport.js";
import { assertStreamOrigin, encodeCheckpointToken } from "./checkpoint.js";
import type { StreamPosition } from "./checkpoint.js";
import type { EventBusRedisClient } from "./client.js";
import type { StreamKeys } from "./keys.js";
import { ACCEPTED_POSITION_VERDICTS } from "./scripts.js";
import type { PositionVerdict } from "./scripts.js";

const ACCEPTED = new Set<string>(ACCEPTED_POSITION_VERDICTS);

/**
 * Why the server refused a position, in the caller's terms.
 *
 * Each entry answers "what would have happened if this had been believed",
 * because that is what an operator reading the error needs: every one of these
 * would have resumed delivery somewhere the consumer never reached.
 */
const REFUSAL_REASONS: Readonly<Record<string, string>> = {
  "origin-missing":
    "this stream instance has no marker, so the position cannot be shown to belong to it; " +
    "the stream's key space was removed or was never written by this transport",
  "origin-mismatch":
    "the position was taken in a different stream instance — another server, another key " +
    "namespace, or a stream that was destroyed and recreated — and means nothing here",
  "origin-unreadable":
    "this stream instance's marker is not a value this transport wrote",
  "stream-key-type": "the key that should hold this stream holds something else",
  "counter-unreadable":
    "this stream's publication counter holds a value this transport did not write",
  "ahead-of-published":
    "the position claims a publication ordinal this stream has never issued",
  "ahead-of-clock":
    "the position names an entry the server's own clock says cannot exist yet, so resuming " +
    "after it would skip every event published between now and then",
  "ahead-of-stream":
    "the position names an entry beyond the newest one this stream holds, so resuming after " +
    "it would skip everything still retained",
  "ordinal-mismatch":
    "the entry exists but carries a different publication ordinal, so the two halves of the " +
    "position describe different events",
  "unknown-entry":
    "no such entry exists, in a range where a real one would still be retained",
  malformed: "the position is not in this transport's shape",
};

const UNAVAILABLE_VERDICTS = new Set<string>([
  "origin-unreadable",
  "stream-key-type",
  "counter-unreadable",
]);

export type PositionJudgement = {
  readonly verdict: PositionVerdict;
  readonly detail: string;
};

/** Reads the `{ verdict, detail }` reply the position scripts return. */
export function parsePositionJudgement(reply: unknown): PositionJudgement {
  if (!Array.isArray(reply)) {
    throw new EventBusUnavailableError(
      "the transport returned a reply shape this implementation cannot read",
      { replyType: typeof reply },
    );
  }
  const [verdict, detail] = reply as unknown[];
  if (typeof verdict !== "string") {
    throw new EventBusUnavailableError("the transport did not return a position verdict", {});
  }
  return { verdict: verdict as PositionVerdict, detail: typeof detail === "string" ? detail : "" };
}

/** True for the verdicts that name a position this stream holds, or held. */
export function isAcceptedPosition(verdict: PositionVerdict): boolean {
  return ACCEPTED.has(verdict);
}

/** Turns a refusal into a typed error; returns quietly for an accepted verdict. */
export function assertPositionAccepted(
  judgement: PositionJudgement,
  context: Readonly<Record<string, unknown>>,
): void {
  if (isAcceptedPosition(judgement.verdict)) {
    return;
  }
  const reason = REFUSAL_REASONS[judgement.verdict] ?? "the position could not be judged";
  const details = { ...context, verdict: judgement.verdict, detail: judgement.detail };
  if (UNAVAILABLE_VERDICTS.has(judgement.verdict)) {
    throw new EventBusUnavailableError(
      `this stream is not in a state a position can be judged against: ${reason}`,
      details,
    );
  }
  throw new EventBusCheckpointError(
    `this checkpoint does not name a position this stream holds: ${reason}`,
    details,
  );
}

/**
 * Returns this stream instance's marker, minting it on first use.
 *
 * Generated here rather than in Lua so the script stays a deterministic
 * function of its arguments.
 */
export async function ensureStreamOrigin(
  client: EventBusRedisClient,
  keys: StreamKeys,
  stream: EventStreamName,
): Promise<string> {
  const candidate = randomBytes(16).toString("hex");
  let reply: string[];
  try {
    reply = await client.ebEnsureOrigin(keys.origin, candidate);
  } catch (cause) {
    throw new EventBusUnavailableError(
      "could not read this stream instance's marker",
      { stream },
      cause,
    );
  }
  const [status, value] = reply;
  if (status !== "ok" || value === undefined) {
    throw new EventBusUnavailableError(
      "this stream instance's marker is not a value this transport wrote",
      { stream, detail: value ?? "" },
    );
  }
  assertStreamOrigin(value);
  return value;
}

/** Asks the server whether a position exists, refusing it when it does not. */
export async function judgePosition(
  client: EventBusRedisClient,
  keys: StreamKeys,
  stream: EventStreamName,
  origin: string,
  position: StreamPosition,
): Promise<void> {
  let reply: string[];
  try {
    reply = await client.ebResolvePosition(
      keys.events,
      keys.published,
      keys.origin,
      origin,
      position.entryId,
      String(position.sequence),
    );
  } catch (cause) {
    throw new EventBusUnavailableError(
      "could not check the checkpoint position against the stream",
      { stream },
      cause,
    );
  }
  assertPositionAccepted(parsePositionJudgement(reply), { stream });
}

/**
 * Records a consumer's position, and only one this stream really holds.
 *
 * Judgement and the write are one server-side step: a position checked and then
 * written would leave a window in which it stopped being valid, and a stored
 * position that names nothing is precisely the value that makes a later restart
 * resume somewhere the consumer never reached.
 */
export async function storeConsumerCheckpoint(
  client: EventBusRedisClient,
  keys: StreamKeys,
  stream: EventStreamName,
  consumerId: ConsumerId,
  origin: string,
  position: StreamPosition,
): Promise<string> {
  const token = encodeCheckpointToken(origin, position);
  let reply: string[];
  try {
    reply = await client.ebStoreCheckpoint(
      keys.events,
      keys.published,
      keys.origin,
      keys.checkpoints,
      origin,
      position.entryId,
      String(position.sequence),
      consumerId,
      token,
    );
  } catch (cause) {
    throw new EventBusUnavailableError(
      "could not record the consumer checkpoint",
      { stream, consumerId },
      cause,
    );
  }
  assertPositionAccepted(parsePositionJudgement(reply), { stream, consumerId });
  return token;
}
