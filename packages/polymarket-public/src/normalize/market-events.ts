/**
 * Market-channel events → frozen domain events.
 *
 * This is the module the work package is actually about: everything upstream of
 * it is transport, everything downstream is the gateway. Four rules govern it.
 *
 * **1. The domain boundary is validated, not trusted.** Every payload this
 * module builds is parsed by its own contract's `payloadSchema` before it is
 * emitted. That costs a second validation pass and buys the guarantee the
 * packet asks for: an adapter that forwarded a raw `null`, an empty string, or
 * a non-canonical decimal into a domain schema would fail here, loudly, in its
 * own tests — not later, in a consumer, on a payload nobody can trace back.
 *
 * **2. Nothing is dropped.** Every fact an inbound frame asserts becomes
 * exactly one event or exactly one problem (§8.3). The accounting unit is the
 * VENUE's unit, not the frame element: an element that asserts one fact
 * produces one outcome, while a `price_change` batching four entries produces
 * four outcomes — one per entry, each stamped with the element's
 * `observedIndex` and its own `entryIndex` — even when three of them fail
 * (round-1 finding L1: this used to be stated as "exactly one outcome per frame
 * element", which the batched case never satisfied).
 *
 * **3. No venue sequence number is invented** (§9.4, ADR-002 §2.3).
 *
 * **4. Where the venue is silent, so is this module.** Three deliberate
 * silences, each with its evidence:
 *
 * - `price_change.hash` is NOT emitted as `BookLevelChanged.venueBookHash`.
 *   The venue documents it as the "Hash of the order that caused this change",
 *   whereas `book.hash` is the "Hash of the orderbook content"
 *   (https://docs.polymarket.com/api-reference/wss/market.md, accessed
 *   2026-08-27). Putting an order hash in a field named for a book hash would
 *   invite a consumer to compare it against a snapshot's and conclude the book
 *   had changed.
 * - `last_trade_price.transaction_hash` is NOT emitted as
 *   `PublicTradeObserved.venueTradeId`. A settlement transaction can carry more
 *   than one trade, so using it as a trade identity would silently deduplicate
 *   distinct trades. The venue supplies no trade id on this channel.
 * - `price_change.best_bid` / `best_ask` do NOT produce a second
 *   `BestBidAskChanged`. The venue has a dedicated top-of-book event
 *   (`best_bid_ask`, behind `custom_feature_enabled`); synthesising a rival
 *   stream of the same event from a different field would leave two
 *   contradictory top-of-book histories with no rule for which wins.
 *
 * ## Book price-change semantics — C-1 / U-1, CONFIRMED 2026-08-27
 *
 * The register (`docs/contracts/protected-contracts.md` §8) carried
 * `price_change` absolute-size and zero-removal semantics as an unconfirmed
 * handoff assumption. The current official market-channel API reference states
 * it, verbatim: `size` is the **"New aggregate size (0 means level removed)"**,
 * and the operation is described as a "Delta update to orderbook price levels
 * when an order is placed or cancelled" — a delta *message*, carrying an
 * absolute level size. Source:
 * https://docs.polymarket.com/api-reference/wss/market.md (accessed
 * 2026-08-27; the `price_change` message's `size` property description). The
 * matching `book` event's level `size` is the "Total size at this price level".
 *
 * This module implements exactly that reading: `size` is passed through as the
 * absolute resulting size at the level, `"0"` included, and no delta arithmetic
 * is performed anywhere. Ratifying the register entry is an orchestrator/ADR
 * step, not this package's to take; see `docs/handoffs/WP-070.md`.
 */

import {
  BestBidAskChangedContract,
  type BestBidAskChangedPayload,
  BookLevelChangedContract,
  type BookLevelChangedPayload,
  BookSnapshotContract,
  type BookSnapshotPayload,
  MarketDiscoveredContract,
  type MarketDiscoveredPayload,
  MarketResolvedContract,
  type MarketResolvedPayload,
  PositiveDecimalStringSchema,
  PublicTradeObservedContract,
  type PublicTradeObservedPayload,
  type TokenId,
  TradingParametersChangedContract,
  type TradingParametersChangedPayload,
} from "@polymarket-bot/domain";
import type { z } from "zod";

import { MARKET_WEBSOCKET_CHANNEL } from "../config.js";
import type { PublicMarketDirectory, PublicMarketIdentity } from "../ports.js";
import {
  type MarketBestBidAskEvent,
  type MarketBookEvent,
  type MarketEvent,
  type MarketLastTradePriceEvent,
  type MarketPriceChangeEvent,
  type MarketResolvedEvent,
  type MarketTickSizeChangeEvent,
  type NewMarketEvent,
  parseMarketEvent,
} from "../venue/market-events.js";
import {
  normalizeLevels,
  readNonNegativeSize,
  readOptionalHash,
  readOptionalPrice,
  readPrice,
  sortLevels,
} from "./fields.js";
import {
  type NormalizedPublicMarketEvent,
  type PublicMarketEventProvenance,
  type PublicMarketNormalization,
  type PublicMarketProblem,
  type PublicMarketProblemCode,
  boundDetail,
} from "./result.js";
import {
  normalizeVenueConditionId,
  normalizeVenueDecimal,
  normalizeVenueInstant,
  normalizeVenueSide,
  normalizeVenueTokenId,
  requireVenueDecimal,
} from "./values.js";

/** Where the frame came from, so provenance can be attached to every event. */
export interface MarketNormalizationContext {
  readonly directory: PublicMarketDirectory;
  /** Defaults to the market WebSocket channel. */
  readonly sourceChannel?: string;
  readonly connectionId?: string;
  readonly subscriptionGeneration?: number;
}

/**
 * Normalizes one inbound market-channel frame.
 *
 * The venue may deliver a single event object or a JSON array of them in one
 * text frame — the official SDK's own market socket branches on
 * `Array.isArray(message)` before dispatching — so callers pass the decoded
 * value(s) as an array and each element is accounted for separately.
 */
export function normalizeMarketEvents(
  values: readonly unknown[],
  context: MarketNormalizationContext,
): PublicMarketNormalization {
  const sink = new NormalizationSink(context);
  values.forEach((value, index) => {
    sink.beginElement(index);
    const parsed = parseMarketEvent(value);
    switch (parsed.status) {
      case "parsed":
        normalizeOne(parsed.event, sink, context.directory);
        return;
      case "unknown-event-type":
        sink.problem(
          "UNKNOWN_EVENT_TYPE",
          `the venue sent event_type "${parsed.eventType}", which this adapter does not model`,
          value,
          { venueEventType: parsed.eventType },
        );
        return;
      case "invalid":
        sink.problem(
          "INVALID_EVENT_PAYLOAD",
          `${parsed.eventType} failed wire validation: ${parsed.issues.join("; ")}`,
          value,
          { venueEventType: parsed.eventType },
        );
        return;
      default:
        sink.problem(
          "UNRECOGNIZED_FRAME",
          "value is not an object carrying a string event_type",
          value,
          {},
        );
    }
  });
  return sink.result();
}

function normalizeOne(
  event: MarketEvent,
  sink: NormalizationSink,
  directory: PublicMarketDirectory,
): void {
  switch (event.event_type) {
    case "book":
      normalizeBook(event, sink, directory);
      return;
    case "price_change":
      normalizePriceChange(event, sink, directory);
      return;
    case "best_bid_ask":
      normalizeBestBidAsk(event, sink, directory);
      return;
    case "last_trade_price":
      normalizeLastTrade(event, sink, directory);
      return;
    case "tick_size_change":
      normalizeTickSizeChange(event, sink, directory);
      return;
    case "new_market":
      normalizeNewMarket(event, sink, directory);
      return;
    case "market_resolved":
      normalizeMarketResolved(event, sink, directory);
  }
}

// --------------------------------------------------------------------------
// book → BookSnapshot
// --------------------------------------------------------------------------

function normalizeBook(
  event: MarketBookEvent,
  sink: NormalizationSink,
  directory: PublicMarketDirectory,
): void {
  const context = describe(event);
  const identity = resolveIdentity(event.asset_id, directory, sink, event, context);
  if (identity === undefined) return;

  const venueTimestamp = readInstant(event.timestamp, "timestamp", sink, event, context);
  if (venueTimestamp === FAILED) return;

  const bids = normalizeLevels(event.bids, "bids");
  if (!bids.ok) {
    sink.problem(bids.failure.code, bids.failure.reason, event, context);
    return;
  }
  const asks = normalizeLevels(event.asks, "asks");
  if (!asks.ok) {
    sink.problem(asks.failure.code, asks.failure.reason, event, context);
    return;
  }

  const hash = readOptionalHash(event.hash);
  const payload: BookSnapshotPayload = {
    internalMarketId: identity.internalMarketId,
    tokenId: identity.tokenId,
    // Descending by price, per `docs/contracts/domain.md`. The venue documents
    // the opposite order for its REST reads ("Bids are ordered by ascending
    // price and asks by descending price"), and its WebSocket examples have
    // shown both, so the order is imposed here rather than assumed from the
    // wire.
    bids: sortLevels(bids.value, "desc"),
    asks: sortLevels(asks.value, "asc"),
    ...(hash === undefined ? {} : { venueBookHash: hash }),
  };
  sink.emit(
    BookSnapshotContract,
    "BookSnapshot",
    payload,
    venueTimestamp,
    event,
    context,
  );
}

// --------------------------------------------------------------------------
// price_change → BookLevelChanged (one per batched entry)
// --------------------------------------------------------------------------

function normalizePriceChange(
  event: MarketPriceChangeEvent,
  sink: NormalizationSink,
  directory: PublicMarketDirectory,
): void {
  const context = describe(event);
  const venueTimestamp = readInstant(event.timestamp, "timestamp", sink, event, context);
  if (venueTimestamp === FAILED) return;

  if (event.price_changes.length === 0) {
    // An empty batch is not an error and not an event: it changed nothing. It
    // is still reported, because a stream of them means something upstream is
    // wrong and silence would hide it.
    sink.problem(
      "INVALID_EVENT_PAYLOAD",
      "price_change carried an empty price_changes array, so it asserts no change",
      event,
      context,
    );
    return;
  }

  // One entry is one book-level change: the element is a BATCH, so each entry
  // gets its own outcome and its own `entryIndex`, and the pair
  // `(observedIndex, entryIndex)` totally orders them within the frame.
  for (const [entryIndex, entry] of event.price_changes.entries()) {
    sink.beginEntry(entryIndex);
    const entryContext = { ...context, tokenId: entry.asset_id };
    const identity = resolveIdentity(entry.asset_id, directory, sink, entry, entryContext);
    if (identity === undefined) continue;

    const side = normalizeVenueSide(entry.side);
    if (side.status !== "ok") {
      sink.problem(
        side.status === "absent" ? "INVALID_EVENT_PAYLOAD" : "UNKNOWN_SIDE",
        side.status === "absent" ? "price change carried no side" : side.reason,
        entry,
        entryContext,
      );
      continue;
    }
    const price = readPrice(entry.price, "price");
    if (!price.ok) {
      sink.problem(price.failure.code, price.failure.reason, entry, entryContext);
      continue;
    }
    // ABSOLUTE size, `"0"` removes the level — confirmed against the current
    // official reference; see this module's header. No delta arithmetic.
    const size = readNonNegativeSize(entry.size, "size");
    if (!size.ok) {
      sink.problem(size.failure.code, size.failure.reason, entry, entryContext);
      continue;
    }

    const payload: BookLevelChangedPayload = {
      internalMarketId: identity.internalMarketId,
      tokenId: identity.tokenId,
      side: side.value,
      price: price.value,
      size: size.value,
    };
    sink.emit(
      BookLevelChangedContract,
      "BookLevelChanged",
      payload,
      venueTimestamp,
      entry,
      entryContext,
    );
  }
  sink.endEntry();
}

// --------------------------------------------------------------------------
// best_bid_ask → BestBidAskChanged
// --------------------------------------------------------------------------

function normalizeBestBidAsk(
  event: MarketBestBidAskEvent,
  sink: NormalizationSink,
  directory: PublicMarketDirectory,
): void {
  const context = describe(event);
  const identity = resolveIdentity(event.asset_id, directory, sink, event, context);
  if (identity === undefined) return;

  const venueTimestamp = readInstant(event.timestamp, "timestamp", sink, event, context);
  if (venueTimestamp === FAILED) return;

  const bestBid = readOptionalPrice(event.best_bid, "best_bid");
  if (!bestBid.ok) {
    sink.problem(bestBid.failure.code, bestBid.failure.reason, event, context);
    return;
  }
  const bestAsk = readOptionalPrice(event.best_ask, "best_ask");
  if (!bestAsk.ok) {
    sink.problem(bestAsk.failure.code, bestAsk.failure.reason, event, context);
    return;
  }

  // Sizes are deliberately absent: the venue's top-of-book event carries
  // prices and a spread, not depth. An absent best bid is not a zero best bid
  // (ADR-001 §8.1), so the key is omitted rather than filled with "0".
  const payload: BestBidAskChangedPayload = {
    internalMarketId: identity.internalMarketId,
    tokenId: identity.tokenId,
    ...(bestBid.value === undefined ? {} : { bestBidPrice: bestBid.value }),
    ...(bestAsk.value === undefined ? {} : { bestAskPrice: bestAsk.value }),
  };
  sink.emit(
    BestBidAskChangedContract,
    "BestBidAskChanged",
    payload,
    venueTimestamp,
    event,
    context,
  );
}

// --------------------------------------------------------------------------
// last_trade_price → PublicTradeObserved
// --------------------------------------------------------------------------

function normalizeLastTrade(
  event: MarketLastTradePriceEvent,
  sink: NormalizationSink,
  directory: PublicMarketDirectory,
): void {
  const context = describe(event);
  const identity = resolveIdentity(event.asset_id, directory, sink, event, context);
  if (identity === undefined) return;

  const venueTimestamp = readInstant(event.timestamp, "timestamp", sink, event, context);
  if (venueTimestamp === FAILED) return;

  const price = readPrice(event.price, "price");
  if (!price.ok) {
    sink.problem(price.failure.code, price.failure.reason, event, context);
    return;
  }

  // The SDK types `size` as an optional decimal, so it may arrive absent, null,
  // or "". `PublicTradeObserved.size` is strictly positive, and there is no
  // honest substitute for a trade size, so an absent one is reported.
  const size = normalizeVenueDecimal(event.size);
  if (size.status === "absent") {
    sink.problem(
      "MISSING_TRADE_SIZE",
      "last_trade_price carried no size, and a trade cannot be published without one",
      event,
      context,
    );
    return;
  }
  if (size.status === "invalid") {
    sink.problem("INVALID_DECIMAL", `size: ${size.reason}`, event, context);
    return;
  }
  if (!PositiveDecimalStringSchema.safeParse(size.value).success) {
    sink.problem(
      "NON_POSITIVE_TRADE_SIZE",
      `trade size ${size.value} is not strictly positive`,
      event,
      context,
    );
    return;
  }

  // `side` is documented "From taker's perspective", which is what licenses
  // mapping it onto `takerSide`.
  const takerSide = normalizeVenueSide(event.side);
  if (takerSide.status === "invalid") {
    sink.problem("UNKNOWN_SIDE", takerSide.reason, event, context);
    return;
  }

  // `venueTradeId` is deliberately omitted; see this module's header.
  const payload: PublicTradeObservedPayload = {
    internalMarketId: identity.internalMarketId,
    tokenId: identity.tokenId,
    price: price.value,
    size: size.value,
    ...(takerSide.status === "ok" ? { takerSide: takerSide.value } : {}),
  };
  sink.emit(
    PublicTradeObservedContract,
    "PublicTradeObserved",
    payload,
    venueTimestamp,
    event,
    context,
  );
}

// --------------------------------------------------------------------------
// tick_size_change → TradingParametersChanged
// --------------------------------------------------------------------------

/**
 * Emits exactly one `TradingParametersChanged` per `tick_size_change`.
 *
 * "Exactly" carries three commitments the tests pin:
 *
 * - one event per venue event, never coalesced and never repeated;
 * - `changedParameters` is `["tick_size"]` alone — the venue event says nothing
 *   about the fee schedule, the delay, or `negRisk`, so naming them would be an
 *   invention;
 * - `tickSize` is the venue's `new_tick_size` normalized to canonical form and
 *   nothing else. In particular the `tick_size` field that rides on a `book`
 *   snapshot never produces one of these events: a snapshot restates the
 *   current parameter, it does not announce a change, and emitting on it would
 *   manufacture a change history the venue never published.
 */
function normalizeTickSizeChange(
  event: MarketTickSizeChangeEvent,
  sink: NormalizationSink,
  directory: PublicMarketDirectory,
): void {
  const context = describe(event);
  const identity = resolveIdentity(event.asset_id, directory, sink, event, context);
  if (identity === undefined) return;

  const venueTimestamp = readInstant(event.timestamp, "timestamp", sink, event, context);
  if (venueTimestamp === FAILED) return;

  const newTick = requireVenueDecimal(event.new_tick_size, "new_tick_size");
  if (newTick.status !== "ok") {
    sink.problem(
      "INVALID_DECIMAL",
      `new_tick_size: ${newTick.status === "absent" ? "absent" : newTick.reason}`,
      event,
      context,
    );
    return;
  }
  if (!PositiveDecimalStringSchema.safeParse(newTick.value).success) {
    sink.problem(
      "INVALID_DECIMAL",
      `new_tick_size ${newTick.value} is not strictly positive`,
      event,
      context,
    );
    return;
  }

  const oldTick = normalizeVenueDecimal(event.old_tick_size);
  if (oldTick.status === "invalid") {
    sink.problem("INVALID_DECIMAL", `old_tick_size: ${oldTick.reason}`, event, context);
    return;
  }

  const assignment = directory.assignTradingParameterVersion({
    identity: identity.identity,
    tokenId: identity.tokenId,
    ...(oldTick.status === "ok" ? { previousTickSize: oldTick.value } : {}),
    tickSize: newTick.value,
    ...(venueTimestamp === undefined ? {} : { observedAt: venueTimestamp }),
  });
  if (assignment === undefined) {
    sink.problem(
      "UNASSIGNED_PARAMETER_VERSION",
      "the catalogue assigned no parameter version, so the change cannot be published with an authoritative reference",
      event,
      context,
    );
    return;
  }

  const payload: TradingParametersChangedPayload = {
    internalMarketId: identity.internalMarketId,
    conditionId: identity.conditionId,
    parametersVersion: assignment.parametersVersion,
    ...(assignment.previousParametersVersion === undefined
      ? {}
      : { previousParametersVersion: assignment.previousParametersVersion }),
    parameterVersionRef: assignment.parameterVersionRef,
    changedParameters: ["tick_size"],
    tickSize: newTick.value,
  };
  sink.emit(
    TradingParametersChangedContract,
    "TradingParametersChanged",
    payload,
    venueTimestamp,
    event,
    context,
  );
}

// --------------------------------------------------------------------------
// new_market → MarketDiscovered
// --------------------------------------------------------------------------

function normalizeNewMarket(
  event: NewMarketEvent,
  sink: NormalizationSink,
  directory: PublicMarketDirectory,
): void {
  const context = describe(event);
  const conditionId = normalizeVenueConditionId(event.market);
  if (conditionId.status !== "ok") {
    sink.problem(
      "INVALID_CONDITION_ID",
      conditionId.status === "absent" ? "new_market carried no market" : conditionId.reason,
      event,
      context,
    );
    return;
  }
  const venueTimestamp = readInstant(event.timestamp, "timestamp", sink, event, context);
  if (venueTimestamp === FAILED) return;

  const tokenIds: TokenId[] = [];
  for (const [index, raw] of (event.assets_ids ?? []).entries()) {
    const tokenId = normalizeVenueTokenId(raw);
    if (tokenId.status !== "ok") {
      sink.problem(
        "INVALID_TOKEN_ID",
        `assets_ids[${String(index)}]: ${tokenId.status === "absent" ? "absent" : tokenId.reason}`,
        event,
        context,
      );
      return;
    }
    tokenIds.push(tokenId.value);
  }

  // The catalogue decides which token is YES and mints the `InternalMarketId`.
  // The venue publishes `assets_ids` and `outcomes` as parallel arrays and
  // documents no pairing rule, so pairing them here would assert unverified
  // venue behaviour.
  const registration = directory.registerDiscoveredMarket({
    venueMarketId: event.id,
    conditionId: conditionId.value,
    ...(event.question == null ? {} : { question: event.question }),
    ...(event.slug == null ? {} : { slug: event.slug }),
    tokenIds,
    outcomes: event.outcomes ?? [],
    ...(venueTimestamp === undefined ? {} : { observedAt: venueTimestamp }),
  });
  if (registration === undefined) {
    sink.problem(
      "UNREGISTERED_MARKET",
      "the catalogue did not register the announced market, so it has no internal identity yet",
      event,
      context,
    );
    return;
  }

  const payload: MarketDiscoveredPayload = {
    internalMarketId: registration.identity.internalMarketId,
    conditionId: registration.identity.conditionId,
    yesTokenId: registration.identity.yesTokenId,
    noTokenId: registration.identity.noTokenId,
    ...(registration.seriesId === undefined ? {} : { seriesId: registration.seriesId }),
    metadataVersion: registration.metadataVersion,
  };
  sink.emit(
    MarketDiscoveredContract,
    "MarketDiscovered",
    payload,
    venueTimestamp,
    event,
    context,
  );
}

// --------------------------------------------------------------------------
// market_resolved → MarketResolved
// --------------------------------------------------------------------------

/**
 * Maps a resolution onto the terminal outcome vocabulary.
 *
 * The outcome is decided by comparing the winning TOKEN against the two outcome
 * tokens the catalogue holds, not by reading the `winning_outcome` label: a
 * label is free text, while the token identity is structural.
 *
 * `SPLIT_50_50` and `CANCELLED` are terminal states this event cannot express —
 * it always names a single winner — and the 50/50 resolution process is itself
 * an open item (U-6, `docs/contracts/protected-contracts.md` §8). A resolution
 * that names no winner is therefore reported, never guessed at.
 */
function normalizeMarketResolved(
  event: MarketResolvedEvent,
  sink: NormalizationSink,
  directory: PublicMarketDirectory,
): void {
  const context = describe(event);
  const venueTimestamp = readInstant(event.timestamp, "timestamp", sink, event, context);
  if (venueTimestamp === FAILED) return;
  if (venueTimestamp === undefined) {
    sink.problem(
      "INVALID_TIMESTAMP",
      "market_resolved carried no timestamp, and MarketResolved.resolvedAt has no substitute",
      event,
      context,
    );
    return;
  }

  if (event.winning_asset_id == null) {
    sink.problem(
      "MISSING_WINNING_TOKEN",
      "market_resolved named no winning_asset_id, so the terminal outcome is undetermined",
      event,
      context,
    );
    return;
  }
  const winner = normalizeVenueTokenId(event.winning_asset_id);
  if (winner.status !== "ok") {
    sink.problem(
      "INVALID_TOKEN_ID",
      `winning_asset_id: ${winner.status === "absent" ? "absent" : winner.reason}`,
      event,
      context,
    );
    return;
  }

  const identity = directory.identityForToken(winner.value);
  if (identity === undefined) {
    sink.problem(
      "UNRESOLVED_MARKET",
      `the catalogue does not know token ${winner.value}, so the resolved market has no internal identity`,
      event,
      { ...context, tokenId: event.winning_asset_id },
    );
    return;
  }

  let outcome: MarketResolvedPayload["outcome"];
  if (winner.value === identity.yesTokenId) {
    outcome = "YES_WIN";
  } else if (winner.value === identity.noTokenId) {
    outcome = "NO_WIN";
  } else {
    sink.problem(
      "UNKNOWN_WINNING_TOKEN",
      `winning token ${winner.value} is neither outcome token of market ${identity.conditionId}`,
      event,
      { ...context, tokenId: event.winning_asset_id },
    );
    return;
  }

  const payload: MarketResolvedPayload = {
    internalMarketId: identity.internalMarketId,
    conditionId: identity.conditionId,
    outcome,
    resolvedAt: venueTimestamp,
  };
  sink.emit(
    MarketResolvedContract,
    "MarketResolved",
    payload,
    venueTimestamp,
    event,
    context,
  );
}

// --------------------------------------------------------------------------
// shared helpers
// --------------------------------------------------------------------------

/** Sentinel distinguishing "timestamp failed" from "timestamp absent". */
const FAILED = Symbol("timestamp-failed");

interface ProblemContext {
  readonly venueEventType?: string;
  readonly tokenId?: string;
  readonly conditionId?: string;
}

function describe(event: { event_type: string; market?: string; asset_id?: string }): ProblemContext {
  return {
    venueEventType: event.event_type,
    ...(event.asset_id === undefined ? {} : { tokenId: event.asset_id }),
    ...(event.market === undefined ? {} : { conditionId: event.market }),
  };
}

/** A resolved identity plus the canonical token id it was resolved from. */
interface ResolvedToken {
  readonly identity: PublicMarketIdentity;
  readonly internalMarketId: PublicMarketIdentity["internalMarketId"];
  readonly conditionId: PublicMarketIdentity["conditionId"];
  readonly tokenId: TokenId;
}

function resolveIdentity(
  rawTokenId: string,
  directory: PublicMarketDirectory,
  sink: NormalizationSink,
  raw: unknown,
  context: ProblemContext,
): ResolvedToken | undefined {
  const tokenId = normalizeVenueTokenId(rawTokenId);
  if (tokenId.status !== "ok") {
    sink.problem(
      "INVALID_TOKEN_ID",
      tokenId.status === "absent" ? "asset_id was absent" : tokenId.reason,
      raw,
      context,
    );
    return undefined;
  }
  const identity = directory.identityForToken(tokenId.value);
  if (identity === undefined) {
    sink.problem(
      "UNRESOLVED_MARKET",
      `the catalogue does not know token ${tokenId.value}; no InternalMarketId exists for it`,
      raw,
      context,
    );
    return undefined;
  }
  return {
    identity,
    internalMarketId: identity.internalMarketId,
    conditionId: identity.conditionId,
    tokenId: tokenId.value,
  };
}

function readInstant(
  value: unknown,
  field: string,
  sink: NormalizationSink,
  raw: unknown,
  context: ProblemContext,
): string | undefined | typeof FAILED {
  const instant = normalizeVenueInstant(value);
  if (instant.status === "invalid") {
    sink.problem("INVALID_TIMESTAMP", `${field}: ${instant.reason}`, raw, context);
    return FAILED;
  }
  return instant.status === "absent" ? undefined : instant.value;
}

/**
 * Accumulates events and problems for one frame.
 *
 * Every emission runs the payload through its contract's `payloadSchema`. A
 * payload that fails becomes a `PAYLOAD_CONTRACT_VIOLATION` problem instead of
 * an event — the adapter reports its own bug rather than shipping a malformed
 * document downstream.
 */
class NormalizationSink {
  readonly #events: NormalizedPublicMarketEvent[] = [];
  readonly #problems: PublicMarketProblem[] = [];
  readonly #sourceChannel: string;
  readonly #connectionId: string | undefined;
  readonly #subscriptionGeneration: number | undefined;
  #index = 0;
  #entryIndex: number | undefined;

  constructor(context: MarketNormalizationContext) {
    this.#sourceChannel = context.sourceChannel ?? MARKET_WEBSOCKET_CHANNEL;
    this.#connectionId = context.connectionId;
    this.#subscriptionGeneration = context.subscriptionGeneration;
  }

  beginElement(index: number): void {
    this.#index = index;
    this.#entryIndex = undefined;
  }

  /** Enters one entry of a batching element, so its outcome is ordered within it. */
  beginEntry(entryIndex: number): void {
    this.#entryIndex = entryIndex;
  }

  /** Leaves the batch: subsequent outcomes belong to the element as a whole. */
  endEntry(): void {
    this.#entryIndex = undefined;
  }

  problem(
    code: PublicMarketProblemCode,
    detail: string,
    raw: unknown,
    context: ProblemContext,
  ): void {
    this.#problems.push({
      code,
      detail: boundDetail(detail),
      sourceChannel: this.#sourceChannel,
      ...(context.venueEventType === undefined ? {} : { venueEventType: context.venueEventType }),
      ...(context.tokenId === undefined ? {} : { tokenId: context.tokenId }),
      ...(context.conditionId === undefined ? {} : { conditionId: context.conditionId }),
      observedIndex: this.#index,
      ...(this.#entryIndex === undefined ? {} : { entryIndex: this.#entryIndex }),
      raw,
    });
  }

  emit<TType extends NormalizedPublicMarketEvent["eventType"], TPayload>(
    contract: { eventType: string; schemaVersion: number; payloadSchema: z.ZodType },
    eventType: TType,
    payload: TPayload,
    venueTimestamp: string | undefined,
    raw: unknown,
    context: ProblemContext,
  ): void {
    const validated = contract.payloadSchema.safeParse(payload);
    if (!validated.success) {
      this.problem(
        "PAYLOAD_CONTRACT_VIOLATION",
        `${eventType} payload was rejected by its own domain contract: ${validated.error.issues
          .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
          .join("; ")}`,
        raw,
        context,
      );
      return;
    }
    const provenance: PublicMarketEventProvenance = {
      source: "polymarket",
      sourceChannel: this.#sourceChannel,
      ...(venueTimestamp === undefined ? {} : { venueTimestamp }),
      ...(this.#connectionId === undefined ? {} : { connectionId: this.#connectionId }),
      ...(this.#subscriptionGeneration === undefined
        ? {}
        : { subscriptionGeneration: this.#subscriptionGeneration }),
      observedIndex: this.#index,
      ...(this.#entryIndex === undefined ? {} : { entryIndex: this.#entryIndex }),
    };
    this.#events.push({
      eventType,
      schemaVersion: contract.schemaVersion,
      payload,
      provenance,
    } as NormalizedPublicMarketEvent);
  }

  result(): PublicMarketNormalization {
    return { events: this.#events, problems: this.#problems };
  }
}
