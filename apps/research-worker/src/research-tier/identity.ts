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
 * - **Reference feeds of other venues** (`binance`, `coinbase`) carry no
 *   Polymarket market content: no identity, nothing unidentified.
 * - **RTDS** is Polymarket's own socket. The gateway subscribes it to the
 *   Chainlink TWAP topics only (`WP-100`), but that is a subscription, not a
 *   guarantee about what arrives, so it is checked frame by frame: a
 *   heartbeat (`PING` / `PONG`) and an envelope on a TWAP topic name nothing;
 *   an envelope on any OTHER topic, or a frame that does not parse, is
 *   unidentified; an identity key anywhere is read like any other.
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
 * ## An inventory is complete, or the frame is unidentified
 *
 * A frame is identified only when the inventory read ALL of it. So a frame is
 * also unidentified, whatever else it names, when:
 *
 * - it does not parse under the ADR-017 §3 strict-JSON profile — above all, a
 *   **duplicate key**, which `JSON.parse` would resolve last-wins, silently
 *   dropping the identities the first spelling named;
 * - it nests deeper than {@link MAX_DEPTH}, where the walk stops reading;
 * - an identity key holds a value that is not a name (a number, an object, an
 *   empty string).
 *
 * None of these occurs in the recorded venue traffic (H1 runs 3-8: nesting at
 * most 4 levels, no duplicate key, every identity value a string).
 *
 * Nothing here interprets a venue fact: it lists names, and an unknown or
 * unreadable name holds the segment (fail closed).
 */

import { decodeInboundFrame } from "@polymarket-bot/polymarket-public";
import { isTwapTopic } from "@polymarket-bot/polymarket-public/rtds";
import type { RawFrameRecord } from "@polymarket-bot/storage-parquet";
import { parseStrictJsonText } from "@polymarket-bot/storage-parquet";

/** The Polymarket market-channel endpoint the gateway records. */
export const POLYMARKET_MARKET_ENDPOINT_PREFIX = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
/** The Gamma market-detail endpoint the lifecycle feed polls. */
export const GAMMA_MARKET_ENDPOINT_PREFIX = "https://gamma-api.polymarket.com/markets/";

/** Other venues' reference feeds: never Polymarket market content. */
const OTHER_VENUE_SOURCES: ReadonlySet<string> = new Set(["binance", "coinbase"]);
/** Polymarket's real-time data socket, subscribed to the Chainlink TWAP topics only. */
const RTDS_SOURCE = "rtds";

const TOKEN_KEYS: ReadonlySet<string> = new Set(["asset_id", "assets_ids", "asset_ids", "token_id", "tokenId", "winning_asset_id"]);
const CONDITION_KEYS: ReadonlySet<string> = new Set(["market", "condition_id", "conditionId"]);

/** How deep the walk reads; anything deeper makes the frame unidentified. */
export const MAX_DEPTH = 16;

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

/** What the walk found; `incomplete` when it could not read all of it. */
type Collected = { tokens: Set<string>; conditions: Set<string>; incomplete: boolean };

const collected = (): Collected => ({ tokens: new Set(), conditions: new Set(), incomplete: false });

function addValue(owner: Collected, into: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length > 0) {
    into.add(value);
    return;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)) {
    for (const item of value as string[]) into.add(item);
    return;
  }
  // An identity key holding something that is not a name: unreadable.
  owner.incomplete = true;
}

/** Collect every identity key's value inside `value`, at any depth up to {@link MAX_DEPTH}. */
function collect(value: unknown, into: Collected, depth: number): void {
  if (value === null || typeof value !== "object") return;
  if (depth > MAX_DEPTH) {
    // Not read: it could name anything.
    into.incomplete = true;
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collect(item, into, depth + 1);
    return;
  }
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (TOKEN_KEYS.has(key)) addValue(into, into.tokens, member);
    else if (CONDITION_KEYS.has(key)) addValue(into, into.conditions, member);
    collect(member, into, depth + 1);
  }
}

function named(found: Collected): boolean {
  return found.tokens.size > 0 || found.conditions.size > 0;
}

function identity(found: Collected, unidentified: boolean): FrameMarketIdentity {
  return { tokens: [...found.tokens], conditions: [...found.conditions], gammaMarkets: [], unidentified: unidentified || found.incomplete };
}

/** ADR-017 §3's strict profile: a duplicate key, above all, is refused rather than resolved last-wins. */
function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: parseStrictJsonText(text) };
  } catch {
    return { ok: false };
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function marketChannel(payload: string): FrameMarketIdentity {
  if (decodeInboundFrame(payload).kind === "pong") return NOTHING;
  const parsed = parseJson(payload);
  if (!parsed.ok) return UNIDENTIFIED;
  const entries = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const all = collected();
  let unidentified = false;
  for (const entry of entries) {
    if (!isObject(entry)) {
      unidentified = true;
      continue;
    }
    const own = collected();
    collect(entry, own, 1);
    if (!named(own) || own.incomplete) unidentified = true;
    for (const token of own.tokens) all.tokens.add(token);
    for (const condition of own.conditions) all.conditions.add(condition);
  }
  return identity(all, unidentified);
}

function otherPolymarketEndpoint(record: RawFrameRecord): FrameMarketIdentity {
  const found = collected();
  try {
    const url = new URL(record.endpoint);
    for (const [key, value] of url.searchParams) {
      if (TOKEN_KEYS.has(key)) addValue(found, found.tokens, value);
      else if (CONDITION_KEYS.has(key)) addValue(found, found.conditions, value);
    }
  } catch {
    // An endpoint that is not a URL names nothing by its query.
  }
  const parsed = parseJson(record.payloadUtf8);
  if (parsed.ok) collect(parsed.value, found, 0);
  // A body that does not parse (strictly) could name anything: whatever the
  // query names, the frame was not read in full.
  else if (record.payloadUtf8.trim().length > 0) found.incomplete = true;
  return identity(found, !named(found));
}

/** An RTDS frame: a heartbeat or a TWAP-topic envelope names nothing; another topic is unidentified. */
function rtdsFrame(payload: string): FrameMarketIdentity {
  const trimmed = payload.trim();
  if (trimmed === "PING" || trimmed === "PONG") return NOTHING;
  const parsed = parseJson(trimmed);
  if (!parsed.ok) return UNIDENTIFIED;
  const envelopes = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const found = collected();
  let unidentified = false;
  for (const envelope of envelopes) {
    if (!isObject(envelope)) {
      unidentified = true;
      continue;
    }
    const topic = envelope["topic"];
    // A topic outside the reference set could carry market content.
    if (topic !== undefined && !(typeof topic === "string" && isTwapTopic(topic))) unidentified = true;
    collect(envelope, found, 1);
  }
  return identity(found, unidentified);
}

/** The markets one raw frame names. */
export function frameMarketIdentity(record: RawFrameRecord): FrameMarketIdentity {
  if (OTHER_VENUE_SOURCES.has(record.source)) return NOTHING;
  if (record.source === RTDS_SOURCE) return rtdsFrame(record.payloadUtf8);
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
