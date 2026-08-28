/**
 * REST order book → `BookSnapshot`.
 *
 * This is the gap-recovery capability. §7.1 and §9.1 are unconditional: "a
 * restart or detected gap requires a new authoritative snapshot before affected
 * markets resume", and the gateway must "resubscribe and obtain authoritative
 * snapshots after gaps". Deciding *when* to do that is the gateway's call
 * (`WP-120`); producing the snapshot is this adapter's.
 *
 * The result is the same `BookSnapshot` payload the WebSocket `book` event
 * produces, built by the same field helpers, so a recovery snapshot and a
 * pushed snapshot are comparable value for value. The only difference is the
 * `sourceChannel` on the provenance, which records which surface it came from.
 */

import {
  BookSnapshotContract,
  type BookSnapshotPayload,
} from "@polymarket-bot/domain";

import { CLOB_BOOK_REST_CHANNEL } from "../config.js";
import type { PublicMarketDirectory } from "../ports.js";
import type { VenueOrderBook } from "../venue/order-book.js";
import {
  normalizeLevels,
  readOptionalHash,
  sortLevels,
} from "./fields.js";
import {
  type NormalizedPublicEvent,
  type PublicMarketNormalization,
  type PublicMarketProblem,
  type PublicMarketProblemCode,
  boundDetail,
} from "./result.js";
import { normalizeVenueInstant, normalizeVenueTokenId } from "./values.js";

/** A normalized REST snapshot. */
export type NormalizedBookSnapshot = NormalizedPublicEvent<"BookSnapshot", BookSnapshotPayload>;

export interface SnapshotNormalizationContext {
  readonly directory: PublicMarketDirectory;
  /** Defaults to the CLOB REST channel. */
  readonly sourceChannel?: string;
  /** Recorded on the provenance when a snapshot is taken to close a gap. */
  readonly subscriptionGeneration?: number;
}

/**
 * Normalizes a batch of order-book bodies.
 *
 * Total, like the WebSocket path: each input book becomes exactly one event or
 * exactly one problem. A snapshot that cannot be normalized must never be
 * treated as a successful recovery, which is why the failures are returned
 * rather than logged.
 */
export function normalizeOrderBooks(
  books: readonly VenueOrderBook[],
  context: SnapshotNormalizationContext,
): PublicMarketNormalization {
  const sourceChannel = context.sourceChannel ?? CLOB_BOOK_REST_CHANNEL;
  const events: NormalizedBookSnapshot[] = [];
  const problems: PublicMarketProblem[] = [];

  books.forEach((book, index) => {
    const push = (code: PublicMarketProblemCode, detail: string): void => {
      problems.push({
        code,
        detail: boundDetail(detail),
        sourceChannel,
        venueEventType: "book",
        tokenId: book.asset_id,
        conditionId: book.market,
        observedIndex: index,
        raw: book,
      });
    };

    const tokenId = normalizeVenueTokenId(book.asset_id);
    if (tokenId.status !== "ok") {
      push(
        "INVALID_TOKEN_ID",
        tokenId.status === "absent" ? "asset_id was absent" : tokenId.reason,
      );
      return;
    }
    const identity = context.directory.identityForToken(tokenId.value);
    if (identity === undefined) {
      push(
        "UNRESOLVED_MARKET",
        `the catalogue does not know token ${tokenId.value}; no InternalMarketId exists for it`,
      );
      return;
    }
    const instant = normalizeVenueInstant(book.timestamp);
    if (instant.status === "invalid") {
      push("INVALID_TIMESTAMP", `timestamp: ${instant.reason}`);
      return;
    }
    const bids = normalizeLevels(book.bids, "bids");
    if (!bids.ok) {
      push(bids.failure.code, bids.failure.reason);
      return;
    }
    const asks = normalizeLevels(book.asks, "asks");
    if (!asks.ok) {
      push(asks.failure.code, asks.failure.reason);
      return;
    }

    const hash = readOptionalHash(book.hash);
    const payload: BookSnapshotPayload = {
      internalMarketId: identity.internalMarketId,
      tokenId: tokenId.value,
      bids: sortLevels(bids.value, "desc"),
      asks: sortLevels(asks.value, "asc"),
      ...(hash === undefined ? {} : { venueBookHash: hash }),
    };
    const validated = BookSnapshotContract.payloadSchema.safeParse(payload);
    if (!validated.success) {
      push(
        "PAYLOAD_CONTRACT_VIOLATION",
        `BookSnapshot payload was rejected by its own domain contract: ${validated.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
      );
      return;
    }

    events.push({
      eventType: "BookSnapshot",
      schemaVersion: BookSnapshotContract.schemaVersion,
      payload,
      provenance: {
        source: "polymarket",
        sourceChannel,
        ...(instant.status === "ok" ? { venueTimestamp: instant.value } : {}),
        ...(context.subscriptionGeneration === undefined
          ? {}
          : { subscriptionGeneration: context.subscriptionGeneration }),
        observedIndex: index,
      },
    });
  });

  return { events, problems };
}
