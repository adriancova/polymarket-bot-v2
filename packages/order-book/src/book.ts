/**
 * One outcome token's local order book (handoff §9.4).
 *
 * A pure state machine fed by frozen domain book events. It owns no
 * connection, reads no clock, and performs no I/O; the composition root feeds
 * it validated envelopes' payloads plus the ingest-meta subset and decides
 * what to do with a refusal.
 *
 * ## Semantics, with their authorities
 *
 * - **Independent per outcome token** (§9.4): one instance maintains exactly
 *   one `(internalMarketId, tokenId)` book. A payload naming anything else is
 *   a typed refusal, never a merge (`ORDER_BOOK_IDENTITY_MISMATCH`).
 * - **Snapshots replace; level changes carry ABSOLUTE sizes; `"0"` removes
 *   the level** (ADR-013 §1–§2, ratifying the venue's "New aggregate size
 *   (0 means level removed)"). The book REPLACES a level's size and never
 *   adds to or subtracts from it.
 * - **Exact decimals only** (§7.3 / ADR-001): every price and size is a
 *   canonical decimal string validated by the frozen domain contracts. A
 *   non-canonical spelling such as `"0.10"` is refused by the contract
 *   (`ORDER_BOOK_INPUT_INVALID`) — this package never normalizes; adapters
 *   own normalization (ADR-001 §3).
 * - **Freshness identity is `(gatewayEpoch, subscriptionGeneration)`**,
 *   adopted from the last applied authoritative snapshot. A level change must
 *   match it exactly: an older generation is the §9.4 stale-generation
 *   refusal; a newer generation is refused pending a snapshot. The producer's
 *   invariant is ONE-WAY (`polymarket-public/src/feed/subscriptions.ts`):
 *   every opened gap advances the generation, but the generation also
 *   advances where no gap is owed (the first connection; a change made while
 *   disconnected). The book therefore cannot tell those causes apart and
 *   fails closed — §7.1 requires an authoritative snapshot under the new
 *   generation before the market resumes. A different epoch is unordered
 *   against this book (`wal-format.md` §12.1 — epochs are identity, not
 *   chronology).
 * - **No invented sequence number** (§9.4 closing rule): ordering uses the
 *   gateway's `ingestSeq` within one epoch, strictly increasing, and nothing
 *   else. `updatesApplied` is a local diagnostic counter, not an ordinal, and
 *   is never compared across books or exposed as ordering.
 * - **A zero-size snapshot level is an empty level** and is not stored: under
 *   ADR-013 a size of zero asserts the level's absence. Storing it would
 *   corrupt depth counts and best-price selection. (Same reading as the
 *   `WP-140` recorder comparison job.)
 */

import {
  addDecimal,
  compareDecimal,
  isCanonicalDecimalString,
  subDecimal,
} from "@polymarket-bot/decimal";
import {
  BookLevelChangedPayloadSchema,
  BookSnapshotPayloadSchema,
  InternalMarketIdSchema,
  PositiveDecimalStringSchema,
  TokenIdSchema,
} from "@polymarket-bot/domain";
import type {
  BookLevelChangedPayload,
  BookSnapshotPayload,
  DecimalString,
  InternalMarketId,
  TokenId,
} from "@polymarket-bot/domain";

import { OrderBookConfigurationError } from "./errors.js";
import type { BookIngestMeta, ValidatedIngestMeta } from "./ingest.js";
import { validateIngestMeta } from "./ingest.js";
import type { ApplyOutcome, Refused } from "./refusals.js";
import { APPLIED, refuse } from "./refusals.js";

/** One aggregated level, canonical decimals. */
export interface BookLevelView {
  readonly price: DecimalString;
  readonly size: DecimalString;
}

/** Best bid/ask and spread. Absent fields mean that side is empty. */
export interface TopOfBook {
  readonly bestBidPrice?: DecimalString;
  readonly bestBidSize?: DecimalString;
  readonly bestAskPrice?: DecimalString;
  readonly bestAskSize?: DecimalString;
  /** `bestAskPrice - bestBidPrice`, exact. Present only when both sides are. */
  readonly spread?: DecimalString;
}

/** Depth summary, exact sums. */
export interface BookDepth {
  readonly bidLevels: number;
  readonly askLevels: number;
  readonly bidShares: DecimalString;
  readonly askShares: DecimalString;
}

/** The last applied update's provenance. */
export interface BookLastUpdate {
  readonly kind: "SNAPSHOT" | "LEVEL_CHANGE";
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly subscriptionGeneration: number;
  readonly venueTimestamp?: string;
  readonly receivedAt?: string;
  readonly receivedAtEpochMs?: number;
}

/** The freshness identity the book currently accepts level changes under. */
export interface BookBaseline {
  readonly gatewayEpoch: string;
  readonly subscriptionGeneration: number;
}

/** Staleness relative to a caller-supplied instant. The book reads no clock. */
export type BookStaleness =
  | { readonly known: true; readonly stalenessMs: number }
  | { readonly known: false; readonly reason: "NO_UPDATE" | "NO_RECEIVED_AT" };

export interface OutcomeTokenBookOptions {
  readonly internalMarketId: string;
  readonly tokenId: string;
}

interface TickState {
  tickSize: DecimalString | undefined;
  /** Bumped on every applied tick-size VALUE change; pins price helpers. */
  tickEpoch: number;
  lastParametersVersion: number | undefined;
}

function summarizeIssues(error: { readonly issues: readonly { readonly path: PropertyKey[]; readonly message: string }[] }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

/** The §9.4 local order book for exactly one outcome token. */
/**
 * `THROUGHPUT-1a`: one side's derived values after ONE level change, from the
 * values before it — the same values a full recomputation gives: the ladder
 * is the same set of `[price, size]` pairs in the same (strict, total) price
 * order, found by binary search with the comparator the sort uses; the share
 * sum is exact decimal arithmetic, so removing the old size and adding the new
 * one is the sum of the new sizes; the best price is the ladder's first.
 * Answers `undefined` — recompute — if the previous values disagree with the
 * change (they cannot, while every write goes through the book).
 */
function bringForward(
  cached: SideCache,
  change: { readonly price: DecimalString; readonly before: DecimalString | undefined; readonly after: DecimalString | undefined; readonly revision: number },
  order: "descending" | "ascending",
): SideCache | undefined {
  const sorted = cached.sorted.slice();
  let low = 0;
  let high = sorted.length;
  let found = -1;
  while (low < high) {
    const middle = (low + high) >> 1;
    const entry = sorted[middle];
    if (entry === undefined) return undefined;
    const raw = compareDecimal(entry[0], change.price);
    const cmp = order === "descending" ? -raw : raw;
    if (cmp === 0) {
      found = middle;
      break;
    }
    if (cmp < 0) low = middle + 1;
    else high = middle;
  }
  if (found !== -1) {
    if (sorted[found]?.[1] !== change.before) return undefined;
    if (change.after === undefined) sorted.splice(found, 1);
    else sorted[found] = [change.price, change.after];
  } else {
    if (change.before !== undefined) return undefined;
    if (change.after !== undefined) sorted.splice(low, 0, [change.price, change.after]);
  }
  let shares = cached.shares;
  if (change.before !== undefined) shares = subDecimal(shares, change.before);
  if (change.after !== undefined) shares = addDecimal(shares, change.after);
  return { revision: change.revision, sorted, shares, best: sorted[0]?.[0] };
}

/** `THROUGHPUT-1a`: one side's derived values at one revision (see `OutcomeTokenBook`). */
interface SideCache {
  readonly revision: number;
  /** `[price, size]` pairs, bids descending / asks ascending. Never handed out; `levels()` copies. */
  readonly sorted: readonly (readonly [DecimalString, DecimalString])[];
  /** The exact sum of the side's sizes. */
  readonly shares: DecimalString;
  /** The best price, as `#bestPrice` finds it. */
  readonly best: DecimalString | undefined;
}

export class OutcomeTokenBook {
  readonly internalMarketId: InternalMarketId;
  readonly tokenId: TokenId;

  /** canonical price -> canonical size (never zero). */
  readonly #bids = new Map<DecimalString, DecimalString>();
  readonly #asks = new Map<DecimalString, DecimalString>();

  #baseline: BookBaseline | undefined;
  /** Last applied `ingestSeq`, valid within `#baseline.gatewayEpoch` only. */
  #lastIngestSeqValue: bigint | undefined;
  #lastVenueBookHash: string | undefined;
  #lastUpdate: BookLastUpdate | undefined;
  /** Local diagnostic counter. NOT an ordinal, NOT a venue sequence (§9.4). */
  #updatesApplied = 0;

  /**
   * `THROUGHPUT-1a` — PERFORMANCE ONLY. Every query below is a pure function
   * of one side's level map, and a consumer asks several of them per event
   * (the serialization asks for both ladders, the top of book and the depth;
   * the strategy's view asks for both ladders again), while an event changes
   * at most ONE side of ONE book. Each side carries a revision that advances
   * on every write to its map (a snapshot's replacement, a level change's set
   * or delete), and each side's sorted ladder, share sum and best price are
   * kept under the revision they were computed at. A query at the same
   * revision answers what it would recompute — the same values, as fresh
   * objects as before.
   */
  #bidRevision = 0;
  #askRevision = 0;
  /**
   * The last level change, so the ONE side it touched can be brought forward
   * from its previous revision (one binary search, one exact add and
   * subtract) instead of re-sorted and re-summed. Cleared by a snapshot.
   */
  #lastLevelChange:
    | {
        readonly side: "BID" | "ASK";
        readonly price: DecimalString;
        /** The size at that price before the change, if the level existed. */
        readonly before: DecimalString | undefined;
        /** The size after the change, or `undefined` when it removed the level. */
        readonly after: DecimalString | undefined;
        /** The side's revision the change produced. */
        readonly revision: number;
      }
    | undefined;
  readonly #sideCache: {
    BID: SideCache | undefined;
    ASK: SideCache | undefined;
  } = { BID: undefined, ASK: undefined };

  readonly #tick: TickState = {
    tickSize: undefined,
    tickEpoch: 0,
    lastParametersVersion: undefined,
  };

  constructor(options: OutcomeTokenBookOptions) {
    const marketId = InternalMarketIdSchema.safeParse(options.internalMarketId);
    if (!marketId.success) {
      throw new OrderBookConfigurationError(
        "ORDER_BOOK_BAD_MARKET_ID",
        `internalMarketId is not a canonical lowercase UUIDv7: ${JSON.stringify(options.internalMarketId)}`,
      );
    }
    const tokenId = TokenIdSchema.safeParse(options.tokenId);
    if (!tokenId.success) {
      throw new OrderBookConfigurationError(
        "ORDER_BOOK_BAD_TOKEN_ID",
        `tokenId is not a canonical unsigned integer string: ${JSON.stringify(options.tokenId)}`,
      );
    }
    this.internalMarketId = marketId.data;
    this.tokenId = tokenId.data;
  }

  // --- application ----------------------------------------------------------

  /**
   * Applies an authoritative `BookSnapshot`. A snapshot (re)baselines the
   * book: levels are replaced wholesale and the snapshot's
   * `(gatewayEpoch, subscriptionGeneration)` becomes the freshness identity.
   */
  applySnapshot(input: { readonly payload: unknown; readonly meta: BookIngestMeta }): ApplyOutcome {
    const meta = validateIngestMeta(input.meta);
    if (!meta.ok) {
      return meta;
    }
    const parsed = BookSnapshotPayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      return refuse(
        "ORDER_BOOK_INPUT_INVALID",
        `BookSnapshot payload failed its frozen domain contract: ${summarizeIssues(parsed.error)}`,
      );
    }
    const payload: BookSnapshotPayload = parsed.data;

    const identity = this.#checkIdentity(payload.internalMarketId, payload.tokenId);
    if (identity !== undefined) {
      return identity;
    }

    const generation = meta.meta.subscriptionGeneration;
    if (generation === undefined) {
      return refuse(
        "ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION",
        "snapshot carries no subscriptionGeneration; WS sessions stamp one, but the generic REST fetcher stamps only when its caller supplies the generation (polymarket-public/src/snapshot/fetcher.ts), so an unstamped snapshot is producible today, is unattributable to a subscription, and is refused — the composition root (WP-120) must stamp gap-closing snapshots via the fetcher context",
        { gatewayEpoch: meta.meta.gatewayEpoch, ingestSeq: meta.meta.ingestSeq },
      );
    }

    if (this.#baseline !== undefined && this.#baseline.gatewayEpoch === meta.meta.gatewayEpoch) {
      if (generation < this.#baseline.subscriptionGeneration) {
        return this.#staleGeneration(generation);
      }
      const ordering = this.#checkIngestOrder(meta.meta);
      if (ordering !== undefined) {
        return ordering;
      }
    }
    // A snapshot from a different epoch re-baselines: §7.1 requires a new
    // authoritative snapshot after a restart, and this is that snapshot.
    // Cross-epoch dispatch order is the caller's (wal-format §12.1: epochs
    // are identity; the book follows internal ingest order per §9.4).

    const bids = this.#levelsToMap(payload.bids, "BID");
    if ("applied" in bids) {
      return bids;
    }
    const asks = this.#levelsToMap(payload.asks, "ASK");
    if ("applied" in asks) {
      return asks;
    }

    this.#bids.clear();
    for (const [price, size] of bids) {
      this.#bids.set(price, size);
    }
    this.#asks.clear();
    for (const [price, size] of asks) {
      this.#asks.set(price, size);
    }
    this.#bidRevision += 1;
    this.#askRevision += 1;
    this.#lastLevelChange = undefined;

    this.#baseline = {
      gatewayEpoch: meta.meta.gatewayEpoch,
      subscriptionGeneration: generation,
    };
    this.#lastIngestSeqValue = meta.meta.ingestSeqValue;
    this.#lastVenueBookHash = payload.venueBookHash;
    this.#recordUpdate("SNAPSHOT", meta.meta, generation);
    return APPLIED;
  }

  /**
   * Applies one `BookLevelChanged` under ADR-013: the carried size REPLACES
   * the level's size, and `"0"` removes the level. Never accumulates.
   */
  applyLevelChange(input: { readonly payload: unknown; readonly meta: BookIngestMeta }): ApplyOutcome {
    const meta = validateIngestMeta(input.meta);
    if (!meta.ok) {
      return meta;
    }
    const parsed = BookLevelChangedPayloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      return refuse(
        "ORDER_BOOK_INPUT_INVALID",
        `BookLevelChanged payload failed its frozen domain contract: ${summarizeIssues(parsed.error)}`,
      );
    }
    const payload: BookLevelChangedPayload = parsed.data;

    const identity = this.#checkIdentity(payload.internalMarketId, payload.tokenId);
    if (identity !== undefined) {
      return identity;
    }

    if (this.#baseline === undefined) {
      return refuse(
        "ORDER_BOOK_NO_BASELINE_SNAPSHOT",
        "a level change arrived before any authoritative snapshot; §7.1 requires a snapshot before affected markets resume",
        { gatewayEpoch: meta.meta.gatewayEpoch, ingestSeq: meta.meta.ingestSeq },
      );
    }
    if (meta.meta.gatewayEpoch !== this.#baseline.gatewayEpoch) {
      return refuse(
        "ORDER_BOOK_EPOCH_MISMATCH",
        "the level change's gatewayEpoch differs from the baseline snapshot's; epochs are identity, not chronology (wal-format §12.1), so the change cannot be sequenced against this book — a new authoritative snapshot must arrive first (§7.1)",
        {
          incomingGatewayEpoch: meta.meta.gatewayEpoch,
          baselineGatewayEpoch: this.#baseline.gatewayEpoch,
        },
      );
    }
    const generation = meta.meta.subscriptionGeneration;
    if (generation === undefined) {
      return refuse(
        "ORDER_BOOK_MISSING_SUBSCRIPTION_GENERATION",
        "level change carries no subscriptionGeneration; WS book events are always stamped with the session's generation, so an unstamped change is unattributable and is refused",
        { gatewayEpoch: meta.meta.gatewayEpoch, ingestSeq: meta.meta.ingestSeq },
      );
    }
    if (generation < this.#baseline.subscriptionGeneration) {
      return this.#staleGeneration(generation);
    }
    if (generation > this.#baseline.subscriptionGeneration) {
      return refuse(
        "ORDER_BOOK_GENERATION_AHEAD_REQUIRES_SNAPSHOT",
        "the level change's subscriptionGeneration is newer than the baseline snapshot's; every opened gap advances the generation (one-way — it also advances without a gap, e.g. on first connection or a change made while disconnected), so the book cannot rule a gap out and §7.1 requires an authoritative snapshot before the market resumes",
        {
          incomingGeneration: generation,
          currentGeneration: this.#baseline.subscriptionGeneration,
        },
      );
    }
    const ordering = this.#checkIngestOrder(meta.meta);
    if (ordering !== undefined) {
      return ordering;
    }

    const side = payload.side === "BID" ? this.#bids : this.#asks;
    const before = side.get(payload.price);
    if (compareDecimal(payload.size, "0") === 0) {
      // ADR-013 §2: size zero DELETES the level. Removing an absent level is
      // a no-op by the same rule — the venue asserts absence, and it is absent.
      side.delete(payload.price);
    } else {
      // ADR-013 §2: REPLACE, never accumulate.
      side.set(payload.price, payload.size);
    }
    if (payload.side === "BID") this.#bidRevision += 1;
    else this.#askRevision += 1;
    this.#lastLevelChange = {
      side: payload.side,
      price: payload.price,
      before,
      after: side.get(payload.price),
      revision: payload.side === "BID" ? this.#bidRevision : this.#askRevision,
    };
    if (payload.venueBookHash !== undefined) {
      this.#lastVenueBookHash = payload.venueBookHash;
    }
    this.#lastIngestSeqValue = meta.meta.ingestSeqValue;
    this.#recordUpdate("LEVEL_CHANGE", meta.meta, generation);
    return APPLIED;
  }

  /**
   * Applies a tick-size change (`TradingParametersChanged` carrying
   * `tickSize`). A VALUE change advances the tick epoch, invalidating every
   * price helper pinned to the previous grid (workplan acceptance 3). A
   * restatement of the identical value applies without invalidating —
   * helpers still conform.
   */
  applyTickSizeChange(input: {
    readonly tickSize: string;
    readonly parametersVersion?: number;
  }): ApplyOutcome {
    const tick = PositiveDecimalStringSchema.safeParse(input.tickSize);
    if (!tick.success) {
      return refuse(
        "ORDER_BOOK_TICK_SIZE_INVALID",
        "tickSize is not a positive canonical decimal string",
        { tickSize: input.tickSize },
      );
    }
    if (input.parametersVersion !== undefined) {
      if (!Number.isSafeInteger(input.parametersVersion) || input.parametersVersion < 1) {
        return refuse(
          "ORDER_BOOK_TICK_SIZE_INVALID",
          "parametersVersion must be a positive safe integer when present",
          { parametersVersion: input.parametersVersion },
        );
      }
      const last = this.#tick.lastParametersVersion;
      if (last !== undefined) {
        if (input.parametersVersion < last) {
          return refuse(
            "ORDER_BOOK_PARAMETERS_VERSION_REGRESSION",
            "the tick-size change names an older parametersVersion than one already applied (§6 invariant: parameter versions are a monotonic ordinal)",
            { incomingParametersVersion: input.parametersVersion, lastParametersVersion: last },
          );
        }
        if (
          input.parametersVersion === last &&
          this.#tick.tickSize !== undefined &&
          compareDecimal(tick.data, this.#tick.tickSize) !== 0
        ) {
          return refuse(
            "ORDER_BOOK_PARAMETERS_VERSION_CONTRADICTION",
            "the tick-size change restates an applied parametersVersion with a different value",
            {
              parametersVersion: input.parametersVersion,
              appliedTickSize: this.#tick.tickSize,
              incomingTickSize: tick.data,
            },
          );
        }
      }
      this.#tick.lastParametersVersion = input.parametersVersion;
    }
    if (this.#tick.tickSize === undefined || compareDecimal(tick.data, this.#tick.tickSize) !== 0) {
      this.#tick.tickSize = tick.data;
      this.#tick.tickEpoch += 1;
    }
    return APPLIED;
  }

  // --- queries --------------------------------------------------------------

  /** Best bid, best ask, and exact spread (§9.4). */
  topOfBook(): TopOfBook {
    const bestBid = this.#side("BID").best;
    const bestAsk = this.#side("ASK").best;
    const result: {
      bestBidPrice?: DecimalString;
      bestBidSize?: DecimalString;
      bestAskPrice?: DecimalString;
      bestAskSize?: DecimalString;
      spread?: DecimalString;
    } = {};
    if (bestBid !== undefined) {
      result.bestBidPrice = bestBid;
      result.bestBidSize = this.#bids.get(bestBid) as DecimalString;
    }
    if (bestAsk !== undefined) {
      result.bestAskPrice = bestAsk;
      result.bestAskSize = this.#asks.get(bestAsk) as DecimalString;
    }
    if (bestBid !== undefined && bestAsk !== undefined) {
      result.spread = subDecimal(bestAsk, bestBid);
    }
    return result;
  }

  /** Level counts and exact per-side share sums (§9.4 depth). */
  depth(): BookDepth {
    return {
      bidLevels: this.#bids.size,
      askLevels: this.#asks.size,
      bidShares: this.#side("BID").shares,
      askShares: this.#side("ASK").shares,
    };
  }

  /** Bids descending / asks ascending, matching the domain payload ordering. */
  levels(side: "BID" | "ASK"): readonly BookLevelView[] {
    return this.#side(side).sorted.map(([price, size]) => ({ price, size }));
  }

  /**
   * `THROUGHPUT-1a`: one side's derived values at its current revision —
   * computed exactly as the queries always computed them, once per revision.
   */
  #side(side: "BID" | "ASK"): SideCache {
    const revision = side === "BID" ? this.#bidRevision : this.#askRevision;
    const cached = this.#sideCache[side];
    if (cached !== undefined && cached.revision === revision) return cached;
    const change = this.#lastLevelChange;
    if (
      cached !== undefined &&
      change !== undefined &&
      change.side === side &&
      change.revision === revision &&
      cached.revision === revision - 1
    ) {
      const forward = bringForward(cached, change, side === "BID" ? "descending" : "ascending");
      if (forward !== undefined) {
        this.#sideCache[side] = forward;
        return forward;
      }
    }
    const map = side === "BID" ? this.#bids : this.#asks;
    const sorted = [...map.entries()].sort((a, b) =>
      side === "BID" ? compareDecimal(b[0], a[0]) : compareDecimal(a[0], b[0]),
    );
    let shares: DecimalString = "0";
    for (const size of map.values()) {
      shares = addDecimal(shares, size);
    }
    const computed: SideCache = {
      revision,
      sorted,
      shares,
      best: this.#bestPrice(map, side === "BID" ? "max" : "min"),
    };
    this.#sideCache[side] = computed;
    return computed;
  }

  /** The venue-provided book hash last carried by an applied event (§9.4). */
  venueBookHash(): string | undefined {
    return this.#lastVenueBookHash;
  }

  /**
   * `C1-HALTS`: forgets the baseline, so the book is NOT synchronized until
   * the next applied snapshot re-baselines it. A consumer calls this when an
   * update was refused for a reason that means the book may have diverged
   * from the venue (a newer generation, another epoch, a refused snapshot):
   * the refusal alone leaves the PRIOR baseline in place, which would still
   * vouch for a superseded book. From here every level change is refused
   * `ORDER_BOOK_NO_BASELINE_SNAPSHOT` and any well-formed snapshot applies.
   * The levels and the last update are kept: they are what the book last
   * knew, and they age (`stalenessMs`) like any book nothing updates.
   */
  clearBaseline(): void {
    this.#baseline = undefined;
    this.#lastIngestSeqValue = undefined;
  }

  /** The freshness identity level changes are currently accepted under. */
  baseline(): BookBaseline | undefined {
    return this.#baseline === undefined ? undefined : { ...this.#baseline };
  }

  /** The last applied update's provenance (§9.4 "last update"). */
  lastUpdate(): BookLastUpdate | undefined {
    return this.#lastUpdate === undefined ? undefined : { ...this.#lastUpdate };
  }

  /** Local diagnostic counter of applied updates. Not an ordinal (§9.4). */
  updatesApplied(): number {
    return this.#updatesApplied;
  }

  /** The current tick size, when one has been applied. */
  tickSize(): DecimalString | undefined {
    return this.#tick.tickSize;
  }

  /** Advances on every applied tick-size VALUE change; pins price helpers. */
  tickEpoch(): number {
    return this.#tick.tickEpoch;
  }

  /**
   * Staleness relative to a caller-supplied instant, in milliseconds. The
   * book never reads a clock; the caller owns "now". A negative value means
   * the caller's clock is behind the gateway's — reported as-is, never
   * clamped.
   */
  stalenessMs(nowEpochMs: number): BookStaleness {
    if (this.#lastUpdate === undefined) {
      return { known: false, reason: "NO_UPDATE" };
    }
    if (this.#lastUpdate.receivedAtEpochMs === undefined) {
      return { known: false, reason: "NO_RECEIVED_AT" };
    }
    return { known: true, stalenessMs: nowEpochMs - this.#lastUpdate.receivedAtEpochMs };
  }

  // --- internals ------------------------------------------------------------

  #checkIdentity(internalMarketId: string, tokenId: string): Refused | undefined {
    if (internalMarketId !== this.internalMarketId || tokenId !== this.tokenId) {
      return refuse(
        "ORDER_BOOK_IDENTITY_MISMATCH",
        "the payload names a different market/token than this book; books are independent per outcome token and are never mixed (§9.4)",
        {
          payloadInternalMarketId: internalMarketId,
          payloadTokenId: tokenId,
          bookInternalMarketId: this.internalMarketId,
          bookTokenId: this.tokenId,
        },
      );
    }
    return undefined;
  }

  #staleGeneration(incoming: number): Refused {
    const current = this.#baseline?.subscriptionGeneration;
    return refuse(
      "ORDER_BOOK_STALE_SUBSCRIPTION_GENERATION",
      "the update's subscriptionGeneration is older than the accepted baseline's (§9.4: reject updates from a stale subscription generation)",
      { incomingGeneration: incoming, currentGeneration: current },
    );
  }

  #checkIngestOrder(meta: ValidatedIngestMeta): Refused | undefined {
    if (this.#lastIngestSeqValue !== undefined && meta.ingestSeqValue <= this.#lastIngestSeqValue) {
      return refuse(
        "ORDER_BOOK_OUT_OF_ORDER_INGEST",
        "ingestSeq did not strictly increase within the epoch (§7.1: gatewayEpoch + ingestSeq defines the exact order consumed); a replayed or reordered update is refused",
        {
          incomingIngestSeq: meta.ingestSeq,
          lastIngestSeq: this.#lastIngestSeqValue.toString(),
        },
      );
    }
    return undefined;
  }

  #levelsToMap(
    levels: readonly { readonly price: DecimalString; readonly size: DecimalString }[],
    side: "BID" | "ASK",
  ): Map<DecimalString, DecimalString> | Refused {
    const map = new Map<DecimalString, DecimalString>();
    for (const level of levels) {
      // The domain contract already enforces the canonical grammar; this is a
      // fail-closed belt in case the payload bypassed the schema (it cannot
      // through the public API, which parses above).
      if (!isCanonicalDecimalString(level.price) || !isCanonicalDecimalString(level.size)) {
        return refuse(
          "ORDER_BOOK_NONCANONICAL_DECIMAL",
          "a snapshot level's price or size is not canonical",
          { side, price: level.price, size: level.size },
        );
      }
      if (compareDecimal(level.size, "0") === 0) {
        // An empty level; not stored (module header, ADR-013 zero-removal).
        continue;
      }
      if (map.has(level.price)) {
        return refuse(
          "ORDER_BOOK_DUPLICATE_SNAPSHOT_LEVEL",
          "one snapshot side carries the same price twice; depth at that price is ambiguous, so the whole snapshot is refused",
          { side, price: level.price },
        );
      }
      map.set(level.price, level.size);
    }
    return map;
  }

  #bestPrice(side: ReadonlyMap<DecimalString, DecimalString>, want: "max" | "min"): DecimalString | undefined {
    let best: DecimalString | undefined;
    for (const price of side.keys()) {
      if (best === undefined) {
        best = price;
        continue;
      }
      const order = compareDecimal(price, best);
      if ((want === "max" && order > 0) || (want === "min" && order < 0)) {
        best = price;
      }
    }
    return best;
  }

  #recordUpdate(
    kind: "SNAPSHOT" | "LEVEL_CHANGE",
    meta: ValidatedIngestMeta,
    generation: number,
  ): void {
    this.#lastUpdate = {
      kind,
      gatewayEpoch: meta.gatewayEpoch,
      ingestSeq: meta.ingestSeq,
      subscriptionGeneration: generation,
      ...(meta.venueTimestamp === undefined ? {} : { venueTimestamp: meta.venueTimestamp }),
      ...(meta.receivedAt === undefined ? {} : { receivedAt: meta.receivedAt }),
      ...(meta.receivedAtEpochMs === undefined ? {} : { receivedAtEpochMs: meta.receivedAtEpochMs }),
    };
    this.#updatesApplied += 1;
  }
}
