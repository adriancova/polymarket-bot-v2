/**
 * Connection identity minting (the WP-080 round-2/round-5 contract, applied
 * gateway-wide).
 *
 * The contract has two parts and this module owns the first:
 *
 * 1. **Uniqueness.** Every connection ATTEMPT gets a `connectionId` the feed
 *    has never seen — never reused across attempts, reconnects, or
 *    make-before-break replacements. All three 1B adapters independently grew
 *    defenses against relabeled connection identity; the gateway must not
 *    reintroduce the defect at the assembly layer, and a strictly increasing
 *    per-feed ordinal PROVES uniqueness where randomness only makes collisions
 *    unlikely.
 * 2. **Registration** (Binance): the driver registers the id with
 *    `feed.connecting(id)` BEFORE opening the socket and stamps the same id on
 *    the socket request. That half lives in `feeds/binance.ts`.
 *
 * The shape is `<feedId>-a<ordinal>`: bounded (Binance caps ids at 100
 * characters; feed ids are capped at 64 by every adapter), collision-free
 * within a feed by construction, and self-describing in an incident.
 *
 * The Coinbase manager mints its own ids (`<feedId>-c<ordinal>`) internally,
 * one per attempt; this factory deliberately uses a different infix (`-a`) so
 * a gateway-minted id can never collide with a manager-minted one even if a
 * feed id were reused across venues.
 */

import { GatewayConfigurationError } from "./errors.js";

/** Longest feed id that keeps `<feedId>-a<ordinal>` inside every adapter bound. */
const MAX_FEED_ID_LENGTH = 64;

export class ConnectionIdFactory {
  readonly #feedId: string;
  #ordinal = 0;

  constructor(feedId: string) {
    if (feedId.length === 0 || feedId.length > MAX_FEED_ID_LENGTH) {
      throw new GatewayConfigurationError(
        `feedId must be 1..${String(MAX_FEED_ID_LENGTH)} characters`,
        { feedId },
      );
    }
    this.#feedId = feedId;
  }

  /** The id for the NEXT connection attempt. Never returns the same value twice. */
  next(): string {
    this.#ordinal += 1;
    return `${this.#feedId}-a${String(this.#ordinal)}`;
  }

  /** How many attempts have been minted. */
  get attempts(): number {
    return this.#ordinal;
  }
}
