/**
 * Which Polymarket markets a raw frame names — inventoried from the frame
 * itself, independently of what the downsampler keeps (`STORAGE-1`; ADR-028
 * Decision 2.3).
 *
 * ## Why this is separate from `interpret.ts`
 *
 * The expiry decision holds a segment while any market it names belongs to no
 * registered window: such a window cannot be classified. The research tier's
 * interpretation keeps only what it samples, so it is the wrong source of
 * truth for "which markets does this segment name": a valid `best_bid_ask`
 * event, an event type the door does not know, or an entry the door finds
 * invalid all produce no observation, yet each still names a market. This
 * module reads identities **generically**, from every Polymarket frame,
 * whatever its event type and whether or not the door accepts it.
 *
 * ## The rules, by source
 *
 * - **Reference feeds** (`binance`, `coinbase`, `rtds`) carry no Polymarket
 *   market content: no identity, nothing unidentified. The gateway subscribes
 *   RTDS to the Chainlink TWAP topics only (`WP-100`).
 * - **Gamma market polls** are identified by the endpoint the gateway polled
 *   (`…/markets/<id>`), never by a body scalar (the market-state door's
 *   `recorded` values are "NOT an authority"). An endpoint whose id does not
 *   read is unidentified.
 * - **The market channel**: a `PONG` (the door's `pong`) and an empty array
 *   name nothing. Otherwise the payload must parse as JSON, and EVERY entry
 *   must be an object that names at least one market through an identity key
 *   at any depth; an entry that names none, or a payload that does not parse,
 *   is unidentified.
 * - **Any other Polymarket endpoint**: identities from its query string and,
 *   when it parses, its body. One that names none is unidentified.
 * - **Any other source**: unidentified.
 *
 * Identity keys: a token is `asset_id`, `assets_ids`, `asset_ids`, `token_id`,
 * `tokenId`, `winning_asset_id`; a condition is `market`, `condition_id`,
 * `conditionId`. A value is a non-empty string or an array of them. Reading
 * more keys than a venue uses only ever names more markets, which holds more.
 *
 * Nothing here interprets a venue fact: it lists names, and an unknown or
 * unreadable name holds the segment (fail closed).
 */

import { decodeInboundFrame } from "@polymarket-bot/polymarket-public";
import type { RawFrameRecord } from "@polymarket-bot/storage-parquet";

/** The Polymarket market-channel endpoint the gateway records. */
export const POLYMARKET_MARKET_ENDPOINT_PREFIX = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
/** The Gamma market-detail endpoint the lifecycle feed polls. */
export const GAMMA_MARKET_ENDPOINT_PREFIX = "https://gamma-api.polymarket.com/markets/";

/** Sources that carry reference data only, never Polymarket market content. */
const REFERENCE_SOURCES: ReadonlySet<string> = new Set(["binance", "coinbase", "rtds"]);

const TOKEN_KEYS: ReadonlySet<string> = new Set(["asset_id", "assets_ids", "asset_ids", "token_id", "tokenId", "winning_asset_id"]);
const CONDITION_KEYS: ReadonlySet<string> = new Set(["market", "condition_id", "conditionId"]);

const MAX_DEPTH = 16;

/** What one frame names. */
export type FrameMarketIdentity = {
  readonly tokens: readonly string[];
  readonly conditions: readonly string[];
  readonly gammaMarkets: readonly string[];
  /** True when the frame could carry market content but names no market this inventory can read. */
  readonly unidentified: boolean;
};

const NOTHING: FrameMarketIdentity = { tokens: [], conditions: [], gammaMarkets: [], unidentified: false };
const UNIDENTIFIED: FrameMarketIdentity = { tokens: [], conditions: [], gammaMarkets: [], unidentified: true };

/** The Gamma market id a lifecycle poll names, from its endpoint; `null` when the frame is not one, or the id does not read. */
export function gammaMarketIdOf(record: RawFrameRecord): string | null {
  if (record.source !== "polymarket" || !record.endpoint.startsWith(GAMMA_MARKET_ENDPOINT_PREFIX)) return null;
  const id = record.endpoint.slice(GAMMA_MARKET_ENDPOINT_PREFIX.length);
  return /^[0-9A-Za-z_-]{1,64}$/u.test(id) ? id : null;
}

type Collected = { tokens: Set<string>; conditions: Set<string> };

function addValue(into: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    if (value.length > 0) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) if (typeof item === "string" && item.length > 0) into.add(item);
  }
}

/** Collect every identity key's value inside `value`, at any depth. */
function collect(value: unknown, into: Collected, depth: number): void {
  if (depth > MAX_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1);
    return;
  }
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (TOKEN_KEYS.has(key)) addValue(into.tokens, member);
    else if (CONDITION_KEYS.has(key)) addValue(into.conditions, member);
    collect(member, into, depth + 1);
  }
}

function named(collected: Collected): boolean {
  return collected.tokens.size > 0 || collected.conditions.size > 0;
}

function identity(collected: Collected, unidentified: boolean): FrameMarketIdentity {
  return { tokens: [...collected.tokens], conditions: [...collected.conditions], gammaMarkets: [], unidentified };
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function marketChannel(payload: string): FrameMarketIdentity {
  if (decodeInboundFrame(payload).kind === "pong") return NOTHING;
  const parsed = parseJson(payload);
  if (!parsed.ok) return UNIDENTIFIED;
  const entries = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const collected: Collected = { tokens: new Set(), conditions: new Set() };
  let unidentified = false;
  for (const entry of entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      unidentified = true;
      continue;
    }
    const own: Collected = { tokens: new Set(), conditions: new Set() };
    collect(entry, own, 0);
    if (!named(own)) unidentified = true;
    for (const token of own.tokens) collected.tokens.add(token);
    for (const condition of own.conditions) collected.conditions.add(condition);
  }
  return identity(collected, unidentified);
}

function otherPolymarketEndpoint(record: RawFrameRecord): FrameMarketIdentity {
  const collected: Collected = { tokens: new Set(), conditions: new Set() };
  try {
    const url = new URL(record.endpoint);
    for (const [key, value] of url.searchParams) {
      if (TOKEN_KEYS.has(key)) addValue(collected.tokens, value);
      else if (CONDITION_KEYS.has(key)) addValue(collected.conditions, value);
    }
  } catch {
    // An endpoint that is not a URL names nothing by its query.
  }
  const parsed = parseJson(record.payloadUtf8);
  if (parsed.ok) collect(parsed.value, collected, 0);
  return identity(collected, !named(collected));
}

/** The markets one raw frame names. */
export function frameMarketIdentity(record: RawFrameRecord): FrameMarketIdentity {
  if (REFERENCE_SOURCES.has(record.source)) return NOTHING;
  if (record.source !== "polymarket") return UNIDENTIFIED;
  if (record.endpoint.startsWith(GAMMA_MARKET_ENDPOINT_PREFIX)) {
    const id = gammaMarketIdOf(record);
    return id === null ? UNIDENTIFIED : { tokens: [], conditions: [], gammaMarkets: [id], unidentified: false };
  }
  if (record.endpoint.startsWith(POLYMARKET_MARKET_ENDPOINT_PREFIX)) return marketChannel(record.payloadUtf8);
  return otherPolymarketEndpoint(record);
}

/** A segment's accumulated inventory. */
export class MarketIdentityInventory {
  readonly #tokens = new Set<string>();
  readonly #conditions = new Set<string>();
  readonly #gammaMarkets = new Set<string>();
  #unidentified = 0;

  add(record: RawFrameRecord): void {
    const found = frameMarketIdentity(record);
    for (const token of found.tokens) this.#tokens.add(token);
    for (const condition of found.conditions) this.#conditions.add(condition);
    for (const gammaMarket of found.gammaMarkets) this.#gammaMarkets.add(gammaMarket);
    if (found.unidentified) this.#unidentified += 1;
  }

  /** The inventory as the research-tier manifest binds it: sorted, unique. */
  result(): {
    readonly polymarketTokenIds: readonly string[];
    readonly conditionIds: readonly string[];
    readonly gammaMarketIds: readonly string[];
    readonly unidentifiedFrames: number;
  } {
    const sorted = (values: Set<string>): string[] => [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return {
      polymarketTokenIds: sorted(this.#tokens),
      conditionIds: sorted(this.#conditions),
      gammaMarketIds: sorted(this.#gammaMarkets),
      unidentifiedFrames: this.#unidentified,
    };
  }
}
