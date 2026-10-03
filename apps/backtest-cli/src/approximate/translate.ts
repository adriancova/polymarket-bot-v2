/**
 * Research-tier samples → the normalized §7.4 envelopes the shared core
 * consumes (`APPROX-REPLAY-1`). Version {@link APPROXIMATE_TRANSLATION_VERSION}.
 *
 * THIS IS THE APPROXIMATION. The research tier keeps, per token, top of book
 * and five levels at most once a second on change, a full book every 60 s and
 * every trade; per reference instrument, 1 s trade bars; and the Gamma polls
 * whose documented state changed (`LEAN-1` §4; ADR-029 Context 2). The core
 * consumes envelopes. Every rule below says which envelope a sample becomes,
 * and what is lost. No rule invents a venue fact: a value the research tier
 * does not hold is absent, never guessed.
 *
 * | Sample | Envelope | What the approximation loses |
 * | --- | --- | --- |
 * | `pm_full_book` | `BookSnapshot`, every level | every change inside the 60 s span |
 * | `pm_depth` | `BookSnapshot`, at most five levels a side, when no full book of that token is released at the same frame | every level below five; every change inside the 1 s span |
 * | `pm_top_of_book` | none: the depth sample of the same token at the same frame holds it (a top of book without one is refused) | — |
 * | `ref_trade_bars` | one `ReferenceTradeObserved`: `price` = the bar's close (its last trade in dispatch order), `size` = the bar's total volume | every trade but the last of each 1 s bar; the core reads only venue, symbol and price |
 * | `pm_trades` | `PublicTradeObserved`; `takerSide` from the venue side by `polymarket-public`'s own `normalizeVenueSide`; a trade with no size, or an unreadable side, is not replayed (the live normalizer refuses it too) | nothing the core reads |
 * | `pm_lifecycle` `gamma-market` | `MarketOpened` / `MarketClosing`, by `UNIV-4`'s rules R1, R2 and R4, at sample resolution (below) | polls whose state did not change are not in the research tier |
 * | `pm_lifecycle` `market_resolved` | none: the research tier keeps no `timestamp`, and `MarketResolved.resolvedAt` has no substitute (the live normalizer's own rule) | the resolution |
 * | `pm_lifecycle` `tick_size_change`, `new_market` | none: the core consumes neither | — |
 * | `chainlink_ticks` | none: the core consumes no TWAP event | — |
 * | `feed_events` | none: connection notes and unreadable frames are counted | the gateway's incidents for them |
 *
 * Plus one derived envelope: the SCHEDULED `MarketClosing` (`UNIV-4` R3),
 * released at the first release frame whose receipt instant is at or after the
 * configured `closeTime`, once the market is open.
 *
 * ## Every envelope of a release frame carries that frame's identity
 *
 * `gatewayEpoch`, `ingestSeq` = the release frame's `ingestSeq`, `receivedAt`
 * = its receipt instant (the samples' available instant, ADR-029 Decision
 * 5.2), `rawSegmentId` = the segment that holds it. The core groups them as
 * one frame (`trading-core` `frames.ts`: no `causationId`, so the key is the
 * dispatch identity) and evaluates once after the last (ADR-024). The event
 * id is derived from that identity under its own namespace
 * ({@link deriveApproximateEventId}), so an approximate event id can never be
 * an exact replay's.
 *
 * `receivedMonotonicNs` is NOT recorded by the research tier. It is derived:
 * the receipt instant in milliseconds, as nanoseconds, never below the
 * previous frame's (the replay clock refuses a monotonic regression, and
 * receipt instants can step backwards). The replay serialization says so.
 *
 * ## Book snapshots carry no delivery session
 *
 * A snapshot rebuilt from a sample is not a frame of any connection. It
 * carries {@link APPROXIMATE_BOOK_SUBSCRIPTION_GENERATION} — the book door
 * requires a generation of at least 1 (`WP-070` generations start at 1), and
 * a constant one never reads as stale — and NO `connectionId`. Under ADR-023's
 * `CONNECTION_CONFIRMED` basis a book update without a `connectionId` falls
 * back to its own last change (`book-freshness.ts` rule 2), so the
 * approximate replay never extends a book's freshness by session liveness.
 * At most one snapshot per token per release frame is emitted: the book's
 * `ingestSeq` must strictly increase, and every sample of one frame shares
 * its `ingestSeq`.
 *
 * ## Lifecycle at sample resolution (`apps/data-gateway` `market-lifecycle.ts`)
 *
 * A Gamma poll is attributed to a configured market by REQUEST, as the
 * gateway attributes it: the row's endpoint must equal
 * `gammaMarketUrl(gammaMarketId)` for the operator-stated id. Per market:
 *
 * - **R1/R2**: the first attributed poll that satisfies the documented
 *   readiness predicate (`isGammaMarketTradeReady`) emits `MarketOpened`,
 *   once. `openedAt` is the configured `openTime` when it is at or before the
 *   poll and no attributed not-ready poll was seen at or after it; otherwise
 *   the poll's receipt instant.
 * - **R3**: the scheduled `MarketClosing`, `closesAt` = the configured
 *   `closeTime`, at the first release frame at or after it, once open (first
 *   in that frame). A market first seen ready after its `closeTime` gets both,
 *   open first.
 * - **R4**: an attributed poll with `closed === true` or
 *   `acceptingOrders === false` while open emits `MarketClosing` with
 *   `closesAt` = the poll's receipt instant; the market is then terminal.
 * - **R5/R6**: a poll that contradicts the configuration before the open, or
 *   turns readiness false some other way while open, emits nothing (the
 *   gateway's incidents for them are not reproduced) and is counted.
 *
 * Every envelope is read through the core's own wire door
 * (`trading-core` `readEventEnvelope`) before it is delivered; one it refuses
 * stops the replay.
 */

import { normalizeVenueSide } from "@polymarket-bot/polymarket-public";
import { gammaMarketUrl, isGammaMarketTradeReady } from "@polymarket-bot/polymarket-public/market-state";
import {
  isoToEpochMilliseconds,
  parseStrictJsonText,
  type EventEnvelope,
  type Sha256HexDigest,
} from "@polymarket-bot/simulation";
import { readEventEnvelope, type TraderConfig } from "@polymarket-bot/trading-core";
import { RESEARCH_DEPTH_LEVELS, type ResearchRow } from "@polymarket-bot/storage-parquet";

import type { ReleaseFrame, ResearchSample } from "./research-source.js";

/**
 * The translation's version. A run pins it as its `normalizerVersion`
 * (§12.5): it is what turns recorded samples into the envelopes the core
 * consumed, as a normalizer turns recorded frames into them.
 */
export const APPROXIMATE_TRANSLATION_VERSION = "backtest-cli/research-tier-samples/v1";

/**
 * The `subscriptionGeneration` every approximate `BookSnapshot` carries: the
 * first generation a `WP-070` subscription ever carries, and the same for
 * every snapshot. It names no real subscription (module header).
 */
export const APPROXIMATE_BOOK_SUBSCRIPTION_GENERATION = 1;

/** The namespace of approximate event ids (see {@link deriveApproximateEventId}). */
const EVENT_ID_NAMESPACE = "polymarket-bot/approximate-replay/v1";

/** One configured market, with the Gamma id its lifecycle polls are attributed by. */
export interface ApproximateMarket {
  readonly marketId: string;
  readonly conditionId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly openTime: string;
  readonly closeTime: string;
  readonly gammaMarketId: string;
}

/** What the translation did with every sample, for the run's own record. */
export interface TranslationCounts {
  readonly samples: number;
  readonly bookSnapshots: number;
  readonly bookSamplesSuperseded: number;
  readonly publicTrades: number;
  readonly tradesNotReplayed: number;
  readonly referenceBars: number;
  readonly referenceBarsNotReplayed: number;
  readonly lifecycleEnvelopes: number;
  readonly gammaPollsAttributed: number;
  readonly gammaPollsUnattributed: number;
  readonly lifecycleRowsNotReplayed: number;
  readonly feedEventsNotReplayed: number;
  readonly chainlinkTicksNotReplayed: number;
  readonly unconfiguredMarketSamples: number;
}

/** One market's lifecycle as the translation derived it. */
export interface LifecycleOutcome {
  readonly marketId: string;
  readonly gammaMarketId: string;
  readonly phase: "PENDING" | "OPEN" | "TERMINAL";
  readonly openedAtFrame: string | null;
  readonly scheduledClosingAtFrame: string | null;
  readonly observedClosingAtFrame: string | null;
  readonly contradictedBeforeOpen: boolean;
  readonly readinessLostWhileOpen: number;
}

/** Why a release frame could not be translated. */
export interface TranslationRefusal {
  readonly code: "APPROX_TRANSLATION_REFUSED";
  readonly detail: string;
  readonly details: Readonly<Record<string, string | number>>;
}

export type FrameTranslation =
  | { readonly ok: true; readonly envelopes: readonly EventEnvelope<unknown>[] }
  | { readonly ok: false; readonly refusal: TranslationRefusal };

/**
 * A deterministic UUIDv7 for an approximate envelope: the 48-bit timestamp is
 * the release frame's receipt instant, and the rest comes from a digest of
 * `(namespace, gatewayEpoch, releaseIngestSeq, index)` — the bit layout of
 * `packages/simulation`'s `deriveReplayEventId`, under a namespace that no
 * exact replay uses.
 */
export function deriveApproximateEventId(
  digest: Sha256HexDigest,
  input: { readonly gatewayEpoch: string; readonly releaseIngestSeq: string; readonly epochMs: number; readonly index: number },
): string {
  const seed = `${EVENT_ID_NAMESPACE}\u001f${input.gatewayEpoch}\u001f${input.releaseIngestSeq}\u001f${String(input.index)}`;
  const hex = digest(new TextEncoder().encode(seed));
  const timestamp = input.epochMs.toString(16).padStart(12, "0");
  const randA = hex.slice(0, 3);
  const variantNibble = "89ab"[parseInt(hex.charAt(3), 16) & 0b11] ?? "8";
  const randB = `${variantNibble}${hex.slice(4, 7)}${hex.slice(7, 19)}`;
  return `${timestamp.slice(0, 8)}-${timestamp.slice(8, 12)}-7${randA}-${randB.slice(0, 4)}-${randB.slice(4, 16)}`;
}

/**
 * The configured markets with their Gamma ids, or the reason they cannot be
 * attributed. Every configured market needs one: without it, its lifecycle
 * polls cannot be attributed and it would never open.
 */
export function approximateMarketsOf(
  config: TraderConfig,
  gammaMarketIds: ReadonlyMap<string, string>,
): { readonly ok: true; readonly markets: readonly ApproximateMarket[] } | { readonly ok: false; readonly problem: string } {
  const configured = new Set(config.markets.map((market) => market.marketId));
  for (const marketId of gammaMarketIds.keys()) {
    if (!configured.has(marketId)) {
      return { ok: false, problem: `a Gamma market id is given for ${marketId}, which the configuration does not name` };
    }
  }
  const markets: ApproximateMarket[] = [];
  for (const market of config.markets) {
    const gammaMarketId = gammaMarketIds.get(market.marketId);
    if (gammaMarketId === undefined || gammaMarketId === "") {
      return {
        ok: false,
        problem:
          `configured market ${market.marketId} has no Gamma market id; its lifecycle polls are attributed by ` +
          "request, as the gateway attributes them, so without one it could never open",
      };
    }
    markets.push({
      marketId: market.marketId,
      conditionId: market.conditionId,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      openTime: market.openTime,
      closeTime: market.closeTime,
      gammaMarketId,
    });
  }
  return { ok: true, markets };
}

interface MarketLifecycle {
  readonly market: ApproximateMarket;
  readonly endpoint: string;
  readonly openMs: number | undefined;
  readonly closeMs: number | undefined;
  phase: "PENDING" | "OPEN" | "TERMINAL";
  scheduledEmitted: boolean;
  notReadyAtOrAfterOpenTime: boolean;
  openedAtFrame: string | null;
  scheduledClosingAtFrame: string | null;
  observedClosingAtFrame: string | null;
  contradictedBeforeOpen: boolean;
  readinessLostWhileOpen: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function str(row: ResearchRow, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

function bool(row: ResearchRow, column: string): boolean | null {
  const value = row[column];
  return typeof value === "boolean" ? value : null;
}

/** The levels of one side of a `pm_depth` row, best first; refuses a gap. */
function depthSide(row: ResearchRow, side: "bid" | "ask"): { price: string; size: string }[] | null {
  const levels: { price: string; size: string }[] = [];
  let ended = false;
  for (let level = 1; level <= RESEARCH_DEPTH_LEVELS; level += 1) {
    const price = str(row, `${side}${String(level)}Price`);
    const size = str(row, `${side}${String(level)}Size`);
    if (price === null || size === null) {
      if (price !== size) return null;
      ended = true;
      continue;
    }
    if (ended) return null;
    levels.push({ price, size });
  }
  return levels;
}

/** The levels of one side of a `pm_full_book` row (canonical JSON pairs), best first. */
function fullSide(json: string | null): { price: string; size: string }[] | null {
  if (json === null) return null;
  const parsed = parseStrictJsonText(json);
  if (!parsed.ok || !Array.isArray(parsed.value)) return null;
  const levels: { price: string; size: string }[] = [];
  for (const entry of parsed.value as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [price, size] = entry as unknown[];
    if (typeof price !== "string" || typeof size !== "string") return null;
    levels.push({ price, size });
  }
  return levels;
}

function isPositiveDecimal(value: string | null): value is string {
  return value !== null && /^(0|[1-9][0-9]*)(\.[0-9]+)?$/u.test(value) && /[1-9]/u.test(value);
}

/**
 * The translation, one release frame at a time, in replay order. Stateful
 * only where the live path is: each market's lifecycle.
 */
export class ResearchSampleTranslator {
  readonly #digest: Sha256HexDigest;
  readonly #byToken = new Map<string, ApproximateMarket>();
  readonly #lifecycles: MarketLifecycle[];
  readonly #counts: Mutable<TranslationCounts> = {
    samples: 0,
    bookSnapshots: 0,
    bookSamplesSuperseded: 0,
    publicTrades: 0,
    tradesNotReplayed: 0,
    referenceBars: 0,
    referenceBarsNotReplayed: 0,
    lifecycleEnvelopes: 0,
    gammaPollsAttributed: 0,
    gammaPollsUnattributed: 0,
    lifecycleRowsNotReplayed: 0,
    feedEventsNotReplayed: 0,
    chainlinkTicksNotReplayed: 0,
    unconfiguredMarketSamples: 0,
  };

  constructor(options: { readonly markets: readonly ApproximateMarket[]; readonly digestSha256: Sha256HexDigest }) {
    this.#digest = options.digestSha256;
    for (const market of options.markets) {
      this.#byToken.set(market.yesTokenId, market);
      this.#byToken.set(market.noTokenId, market);
    }
    this.#lifecycles = options.markets.map((market) => ({
      market,
      endpoint: gammaMarketUrl(market.gammaMarketId),
      openMs: isoToEpochMilliseconds(market.openTime),
      closeMs: isoToEpochMilliseconds(market.closeTime),
      phase: "PENDING",
      scheduledEmitted: false,
      notReadyAtOrAfterOpenTime: false,
      openedAtFrame: null,
      scheduledClosingAtFrame: null,
      observedClosingAtFrame: null,
      contradictedBeforeOpen: false,
      readinessLostWhileOpen: 0,
    }));
  }

  counts(): TranslationCounts {
    return { ...this.#counts };
  }

  lifecycles(): readonly LifecycleOutcome[] {
    return this.#lifecycles.map((lifecycle) => ({
      marketId: lifecycle.market.marketId,
      gammaMarketId: lifecycle.market.gammaMarketId,
      phase: lifecycle.phase,
      openedAtFrame: lifecycle.openedAtFrame,
      scheduledClosingAtFrame: lifecycle.scheduledClosingAtFrame,
      observedClosingAtFrame: lifecycle.observedClosingAtFrame,
      contradictedBeforeOpen: lifecycle.contradictedBeforeOpen,
      readinessLostWhileOpen: lifecycle.readinessLostWhileOpen,
    }));
  }

  /** Translates one release frame. `receivedMonotonicNs` is the frame's derived reading. */
  translate(frame: ReleaseFrame, receivedMonotonicNs: string): FrameTranslation {
    const out: EventEnvelope<unknown>[] = [];
    let problem: TranslationRefusal | undefined;
    const refuse = (detail: string, details: Readonly<Record<string, string | number>> = {}): void => {
      problem ??= {
        code: "APPROX_TRANSLATION_REFUSED",
        detail,
        details: { releaseIngestSeq: frame.releaseIngestSeq, ...details },
      };
    };
    const emit = (
      sourceTable: string,
      eventType: string,
      source: EventEnvelope<unknown>["source"],
      payload: Readonly<Record<string, unknown>>,
      book: boolean,
    ): void => {
      if (problem !== undefined) return;
      const envelope = {
        eventId: deriveApproximateEventId(this.#digest, {
          gatewayEpoch: frame.gatewayEpoch,
          releaseIngestSeq: frame.releaseIngestSeq,
          epochMs: frame.availableAtEpochMs,
          index: out.length,
        }),
        eventType,
        schemaVersion: 1,
        source,
        sourceChannel: `approximate:research-tier/${sourceTable}`,
        receivedAt: frame.availableAt,
        receivedMonotonicNs,
        gatewayEpoch: frame.gatewayEpoch,
        ingestSeq: frame.releaseIngestSeq,
        ...(book ? { subscriptionGeneration: APPROXIMATE_BOOK_SUBSCRIPTION_GENERATION } : {}),
        rawSegmentId: frame.releaseSegmentId,
        payload,
      };
      // The core's own wire door: what it refuses here it would refuse live.
      const read = readEventEnvelope(envelope);
      if (!read.ok) {
        refuse(`the ${eventType} built from a ${sourceTable} sample failed the core's event door (${read.refusal.code})`, {
          issues: read.refusal.issues.join("; ").slice(0, 500),
        });
        return;
      }
      out.push(read.envelope);
    };

    // --- R3: the scheduled closing, first in the frame --------------------
    for (const lifecycle of this.#lifecycles) {
      if (
        lifecycle.phase === "OPEN" &&
        !lifecycle.scheduledEmitted &&
        lifecycle.closeMs !== undefined &&
        frame.availableAtEpochMs >= lifecycle.closeMs
      ) {
        this.#emitScheduledClosing(lifecycle, frame, emit);
      }
    }

    // --- the book sample each token's snapshot is built from ---------------
    const books = new Map<string, { full?: ResearchSample; depth?: ResearchSample; top?: ResearchSample }>();
    for (const sample of frame.samples) {
      if (sample.table !== "pm_full_book" && sample.table !== "pm_depth" && sample.table !== "pm_top_of_book") continue;
      const tokenId = str(sample.row, "tokenId") ?? "";
      const entry = books.get(tokenId) ?? {};
      if (sample.table === "pm_full_book") entry.full = sample;
      else if (sample.table === "pm_depth") entry.depth = sample;
      else entry.top = sample;
      books.set(tokenId, entry);
    }
    for (const [tokenId, entry] of books) {
      if (entry.top !== undefined && entry.depth === undefined) {
        refuse(
          "a top-of-book sample has no depth sample of the same token at the same release frame; downsampling v1 " +
            "always releases one with it, so this dataset is not what it claims to be",
          { tokenId },
        );
      }
    }

    for (const sample of frame.samples) {
      if (problem !== undefined) break;
      this.#counts.samples += 1;
      const row = sample.row;
      switch (sample.table) {
        case "pm_top_of_book":
        case "pm_depth":
        case "pm_full_book": {
          const tokenId = str(row, "tokenId") ?? "";
          const market = this.#marketOf(tokenId, str(row, "conditionId"), refuse);
          if (market === undefined) {
            this.#counts.unconfiguredMarketSamples += 1;
            break;
          }
          const entry = books.get(tokenId);
          const chosen = entry?.full ?? entry?.depth;
          if (chosen !== sample) {
            this.#counts.bookSamplesSuperseded += 1;
            break;
          }
          const bids = sample.table === "pm_full_book" ? fullSide(str(row, "bidsJson")) : depthSide(row, "bid");
          const asks = sample.table === "pm_full_book" ? fullSide(str(row, "asksJson")) : depthSide(row, "ask");
          if (bids === null || asks === null) {
            refuse(`a ${sample.table} sample's levels could not be read`, { tokenId });
            break;
          }
          emit(sample.table, "BookSnapshot", "polymarket", { internalMarketId: market.marketId, tokenId, bids, asks }, true);
          this.#counts.bookSnapshots += 1;
          break;
        }
        case "pm_trades": {
          const tokenId = str(row, "tokenId") ?? "";
          const market = this.#marketOf(tokenId, str(row, "conditionId"), refuse);
          if (market === undefined) {
            this.#counts.unconfiguredMarketSamples += 1;
            break;
          }
          const price = str(row, "price");
          const size = str(row, "size");
          const side = normalizeVenueSide(row["side"]);
          if (price === null || !isPositiveDecimal(size) || side.status === "invalid") {
            this.#counts.tradesNotReplayed += 1;
            break;
          }
          emit(
            "pm_trades",
            "PublicTradeObserved",
            "polymarket",
            { internalMarketId: market.marketId, tokenId, price, size, ...(side.status === "ok" ? { takerSide: side.value } : {}) },
            false,
          );
          this.#counts.publicTrades += 1;
          break;
        }
        case "ref_trade_bars": {
          const venue = str(row, "source");
          const symbol = str(row, "instrument");
          const close = str(row, "close");
          const volume = str(row, "volume");
          if ((venue !== "binance" && venue !== "coinbase") || symbol === null || !isPositiveDecimal(close) || !isPositiveDecimal(volume)) {
            this.#counts.referenceBarsNotReplayed += 1;
            break;
          }
          emit("ref_trade_bars", "ReferenceTradeObserved", venue, { venue, symbol, price: close, size: volume }, false);
          this.#counts.referenceBars += 1;
          break;
        }
        case "pm_lifecycle":
          if (str(row, "eventType") === "gamma-market") {
            this.#gammaPoll(row, frame, emit);
          } else {
            this.#counts.lifecycleRowsNotReplayed += 1;
          }
          break;
        case "feed_events":
          this.#counts.feedEventsNotReplayed += 1;
          break;
        case "chainlink_ticks":
          this.#counts.chainlinkTicksNotReplayed += 1;
          break;
      }
    }
    if (problem !== undefined) return { ok: false, refusal: problem };
    return { ok: true, envelopes: out };
  }

  #marketOf(
    tokenId: string,
    conditionId: string | null,
    refuse: (detail: string, details?: Readonly<Record<string, string | number>>) => void,
  ): ApproximateMarket | undefined {
    const market = this.#byToken.get(tokenId);
    if (market !== undefined && conditionId !== market.conditionId) {
      refuse(
        "a sample names a configured token under another condition id than the configuration's; the replay " +
          "does not guess which is right",
        { tokenId, sampleConditionId: conditionId ?? "", configuredConditionId: market.conditionId },
      );
      return undefined;
    }
    return market;
  }

  #emitScheduledClosing(
    lifecycle: MarketLifecycle,
    frame: ReleaseFrame,
    emit: (table: string, eventType: string, source: EventEnvelope<unknown>["source"], payload: Readonly<Record<string, unknown>>, book: boolean) => void,
  ): void {
    emit(
      "schedule",
      "MarketClosing",
      "polymarket",
      { internalMarketId: lifecycle.market.marketId, conditionId: lifecycle.market.conditionId, closesAt: lifecycle.market.closeTime },
      false,
    );
    lifecycle.scheduledEmitted = true;
    lifecycle.scheduledClosingAtFrame = frame.releaseIngestSeq;
    this.#counts.lifecycleEnvelopes += 1;
  }

  #gammaPoll(
    row: ResearchRow,
    frame: ReleaseFrame,
    emit: (table: string, eventType: string, source: EventEnvelope<unknown>["source"], payload: Readonly<Record<string, unknown>>, book: boolean) => void,
  ): void {
    const lifecycle = this.#lifecycles.find((candidate) => candidate.endpoint === str(row, "endpoint"));
    if (lifecycle === undefined) {
      this.#counts.gammaPollsUnattributed += 1;
      return;
    }
    this.#counts.gammaPollsAttributed += 1;
    const state = {
      active: bool(row, "active"),
      closed: bool(row, "closed"),
      archived: bool(row, "archived"),
      acceptingOrders: bool(row, "acceptingOrders"),
      restricted: bool(row, "restricted"),
      gameStartTime: null,
      recorded: {},
    };
    const ready = isGammaMarketTradeReady(state);
    const at = frame.availableAtEpochMs;
    const market = lifecycle.market;
    switch (lifecycle.phase) {
      case "PENDING": {
        if (state.closed === true || state.archived === true) {
          // R5: the venue contradicts the configuration; nothing is emitted.
          lifecycle.contradictedBeforeOpen = true;
          lifecycle.phase = "TERMINAL";
          return;
        }
        if (!ready) {
          if (lifecycle.openMs !== undefined && at >= lifecycle.openMs) lifecycle.notReadyAtOrAfterOpenTime = true;
          return;
        }
        // R1, with R2's openedAt.
        const openedAt =
          lifecycle.openMs !== undefined && lifecycle.openMs <= at && !lifecycle.notReadyAtOrAfterOpenTime
            ? market.openTime
            : frame.availableAt;
        emit("pm_lifecycle", "MarketOpened", "polymarket", { internalMarketId: market.marketId, conditionId: market.conditionId, openedAt }, false);
        lifecycle.phase = "OPEN";
        lifecycle.openedAtFrame = frame.releaseIngestSeq;
        this.#counts.lifecycleEnvelopes += 1;
        // R3 on the same poll: a market first seen ready after its close time.
        if (lifecycle.closeMs !== undefined && at >= lifecycle.closeMs) this.#emitScheduledClosing(lifecycle, frame, emit);
        return;
      }
      case "OPEN": {
        if (state.closed === true || state.acceptingOrders === false) {
          // R4: the venue's own close, at the poll's receipt instant.
          emit(
            "pm_lifecycle",
            "MarketClosing",
            "polymarket",
            { internalMarketId: market.marketId, conditionId: market.conditionId, closesAt: frame.availableAt },
            false,
          );
          lifecycle.phase = "TERMINAL";
          lifecycle.observedClosingAtFrame = frame.releaseIngestSeq;
          this.#counts.lifecycleEnvelopes += 1;
          return;
        }
        // R6: readiness lost some other way; nothing is emitted.
        if (!ready) lifecycle.readinessLostWhileOpen += 1;
        return;
      }
      case "TERMINAL":
        return;
    }
  }
}
