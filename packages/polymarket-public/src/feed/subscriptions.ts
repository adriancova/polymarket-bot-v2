/**
 * Market-channel subscription manager.
 *
 * Owns two things and nothing else: the set of token ids the process wants, and
 * the `subscriptionGeneration` that identifies which subscription an event
 * arrived under. It is pure — no socket, no clock, no I/O — so the generation
 * rules can be tested exhaustively without a connection.
 *
 * ## Generations
 *
 * ADR-002 §2.4, from §7.1: "A resubscription creates a new
 * `subscriptionGeneration`; a restart or a detected gap requires a new
 * authoritative snapshot before affected markets resume." So the counter
 * advances on exactly two things:
 *
 * - an **addition to the desired set** that will be pushed to the server, and
 * - a **full (re)subscription**, which is what happens on every connect and
 *   every reconnect.
 *
 * It does NOT advance on a no-op change. Requesting a token that is already
 * subscribed sends nothing, so nothing was resubscribed, and inventing a
 * generation for it would tell a consumer to expect a snapshot that will never
 * come.
 *
 * It does NOT advance on a **removal** either, and that is a round-1 review fix
 * (finding H2). A removal used to advance it, which meant a live feed could
 * publish events under a brand-new generation with no gap and no explanation:
 * a consumer reading `subscriptionGeneration` as "the subscription was
 * replaced, expect a snapshot" saw a boundary that never happened. The venue's
 * dynamic `unsubscribe` frame removes only the named assets and leaves the rest
 * of the subscription untouched, so for everything still subscribed nothing was
 * missed and nothing is owed. The rule the feed now enforces is the honest one:
 * **on a live connection the generation advances exactly when a gap is opened
 * for it.**
 *
 * The counter starts at `0`, meaning "nothing has been subscribed yet"; the
 * first real subscription is generation `1`. `0` is therefore never carried by
 * an event, which makes an unset generation distinguishable from a real one.
 *
 * ## Asset-count limits — venue item U-3
 *
 * No maximum `assets_ids` per subscription is documented anywhere. This manager
 * therefore imposes none by default, and imposing none is NOT a claim that none
 * exists. `maximumAssetsPerFrame` exists so that an operator who learns the
 * real bound can apply it without a code change: the token list is then split
 * across several frames, the first carrying the documented `type: "market"`
 * subscription and the rest carrying documented dynamic `subscribe` updates —
 * both frame shapes the venue publishes, in the order it publishes them.
 */

import { PublicMarketConfigurationError } from "../errors.js";
import {
  buildMarketSubscribeFrame,
  buildMarketSubscribeUpdateFrame,
  buildMarketUnsubscribeUpdateFrame,
  type MarketSubscriptionFrame,
} from "../venue/frames.js";

export interface MarketSubscriptionManagerOptions {
  /** Request `best_bid_ask`, `new_market` and `market_resolved`. */
  readonly customFeatureEnabled: boolean;
  /** Ask the server for an initial book snapshot on subscribe. */
  readonly initialDump: boolean;
  /** Client-imposed cap on tokens per frame; unset means no cap (U-3). */
  readonly maximumAssetsPerFrame?: number;
}

/** The result of changing the desired token set while a connection is open. */
export interface SubscriptionDelta {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /**
   * The generation after the change.
   *
   * Unchanged when nothing changed, and unchanged by a removal: only an
   * addition or a full (re)subscription replaces server-side subscription
   * state.
   */
  readonly generation: number;
  /** Frames to send on an open connection. Empty when nothing changed. */
  readonly frames: readonly MarketSubscriptionFrame[];
}

/** A full (re)subscription of the whole desired set. */
export interface FullSubscription {
  readonly generation: number;
  readonly assets: readonly string[];
  /** Empty when nothing is desired: there is no meaningful empty subscription. */
  readonly frames: readonly MarketSubscriptionFrame[];
}

export class MarketSubscriptionManager {
  /** Insertion-ordered, so the frames a test asserts on are deterministic. */
  readonly #assets = new Set<string>();
  readonly #options: MarketSubscriptionManagerOptions;
  #generation = 0;

  constructor(options: MarketSubscriptionManagerOptions) {
    const cap = options.maximumAssetsPerFrame;
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1)) {
      throw new PublicMarketConfigurationError(
        "maximumAssetsPerFrame must be a positive integer when set",
        { maximumAssetsPerFrame: cap },
      );
    }
    this.#options = options;
  }

  /** The tokens currently desired, in the order they were first requested. */
  get assets(): readonly string[] {
    return [...this.#assets];
  }

  /** The current `subscriptionGeneration`. `0` means nothing subscribed yet. */
  get generation(): number {
    return this.#generation;
  }

  /** Whether anything is desired at all. */
  get isEmpty(): boolean {
    return this.#assets.size === 0;
  }

  /**
   * Adds tokens to the desired set.
   *
   * Returns the frames an open connection should send. A token already in the
   * set is not re-sent: the venue rejects a duplicate asset on a subscribe
   * update, and re-subscribing something already subscribed would also claim a
   * generation boundary that did not happen.
   */
  add(tokenIds: readonly string[]): SubscriptionDelta {
    const added: string[] = [];
    for (const tokenId of tokenIds) {
      if (tokenId === "") continue;
      if (this.#assets.has(tokenId)) continue;
      this.#assets.add(tokenId);
      added.push(tokenId);
    }
    if (added.length === 0) {
      return { added: [], removed: [], generation: this.#generation, frames: [] };
    }
    this.#generation += 1;
    return {
      added,
      removed: [],
      generation: this.#generation,
      frames: this.#chunk(added).map((chunk) =>
        buildMarketSubscribeUpdateFrame(chunk, this.#options.customFeatureEnabled),
      ),
    };
  }

  /**
   * Removes tokens from the desired set, RETAINING the generation.
   *
   * Removing an asset does not replace the subscription for the assets that
   * remain: the venue's dynamic `unsubscribe` frame names the assets to drop
   * and leaves the rest in place, so nothing that is still subscribed missed
   * anything. Advancing the generation here would announce a subscription
   * boundary — and therefore, per §7.1, a snapshot obligation — for markets
   * whose stream never broke (round-1 finding H2).
   */
  remove(tokenIds: readonly string[]): SubscriptionDelta {
    const removed: string[] = [];
    for (const tokenId of tokenIds) {
      if (!this.#assets.has(tokenId)) continue;
      this.#assets.delete(tokenId);
      removed.push(tokenId);
    }
    if (removed.length === 0) {
      return { added: [], removed: [], generation: this.#generation, frames: [] };
    }
    return {
      added: [],
      removed,
      generation: this.#generation,
      frames: this.#chunk(removed).map((chunk) => buildMarketUnsubscribeUpdateFrame(chunk)),
    };
  }

  /**
   * Plans a full subscription of everything desired, advancing the generation.
   *
   * Called on every connect and every reconnect: a new connection has no
   * server-side subscription state, so the whole set is re-sent and the
   * generation advances, which is precisely the signal the gateway needs to
   * require a fresh authoritative snapshot (§7.1, §9.1).
   */
  planFullSubscription(): FullSubscription {
    const assets = [...this.#assets];
    if (assets.length === 0) {
      // Nothing desired: no frame is sent, and the generation does not move.
      // A subscription to nothing is not a subscription.
      return { generation: this.#generation, assets, frames: [] };
    }
    this.#generation += 1;
    const chunks = this.#chunk(assets);
    const [first, ...rest] = chunks;
    const frames: MarketSubscriptionFrame[] = [
      buildMarketSubscribeFrame({
        assetsIds: first ?? [],
        customFeatureEnabled: this.#options.customFeatureEnabled,
        initialDump: this.#options.initialDump,
      }),
      ...rest.map((chunk) =>
        buildMarketSubscribeUpdateFrame(chunk, this.#options.customFeatureEnabled),
      ),
    ];
    return { generation: this.#generation, assets, frames };
  }

  #chunk(values: readonly string[]): readonly (readonly string[])[] {
    const size = this.#options.maximumAssetsPerFrame;
    if (size === undefined || values.length <= size) {
      return [values];
    }
    const chunks: string[][] = [];
    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  }
}
