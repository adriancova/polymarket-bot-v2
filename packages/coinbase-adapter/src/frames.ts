/**
 * Frame decoding and classification.
 *
 * One pure function turns a raw transport frame into a discriminated union.
 * It cannot throw and it cannot lose a frame: every input maps to exactly one
 * variant, and the two failure variants carry the raw text (or, for a binary
 * frame, its length) so the caller can preserve it.
 *
 * The classification is deliberately coarse. It answers "which documented shape
 * is this, if any?" and nothing else. Deciding what an unknown `side` value
 * means, or whether a top of book actually changed, belongs to `normalize.ts`
 * and `stream-processor.ts`; keeping those decisions out of here is what makes
 * this function trivially testable against every fixture.
 *
 * THE PARSE IS NOT THE DOOR (`REC-1`, ADR-020 §3, `schema-boundary.md` §3).
 * `zod` reads a schema's DECLARED keys through the prototype chain, so a
 * successful parse is not evidence that the frame carried them — and `channel`
 * is what ROUTES a frame into the recorded dataset. Every frame is therefore
 * materialized prototype-free by `./wire-door.ts` before any schema runs, the
 * routing fields are read from that tree by this module's own checks, the tree
 * is what the classification carries, and both the parse and its refusal
 * rendering happen inside a containment. See that module's header for which of
 * D1–D4 this door performs and which it does not.
 */

import { COINBASE_CHANNELS } from "./venue-facts.js";
import {
  containedParse,
  isOwnRecord,
  ownDefine,
  ownEmit,
  ownNonEmptyString,
  ownRecord,
  ownSafeInt,
  readOwnFrame,
  type OwnRecord,
} from "./wire-door.js";
import {
  CoinbaseFrameEnvelopeSchema,
  CoinbaseHeartbeatsFrameSchema,
  CoinbaseMarketTradesFrameSchema,
  CoinbaseTickerFrameSchema,
  type CoinbaseFrameEnvelope,
  type CoinbaseHeartbeatsFrame,
  type CoinbaseMarketTradesFrame,
  type CoinbaseTickerFrame,
} from "./wire.js";
import type { CoinbaseRawFrame } from "./ports.js";

/** Why a frame could not be classified as a documented shape. */
export type CoinbaseFrameRejection =
  /** Not a text frame. Refused rather than decoded on a guess (ADR-004 §1). */
  | "NOT_TEXT"
  /** Text, but `JSON.parse` refused it. */
  | "NOT_JSON"
  /** JSON, but not the documented envelope or not the documented channel shape. */
  | "SHAPE";

/** What a raw frame turned out to be. Exhaustive: every input lands in one arm. */
export type CoinbaseClassifiedFrame =
  | {
      readonly kind: "MARKET_TRADES";
      readonly text: string;
      readonly frame: CoinbaseMarketTradesFrame;
    }
  | { readonly kind: "TICKER"; readonly text: string; readonly frame: CoinbaseTickerFrame }
  | { readonly kind: "HEARTBEATS"; readonly text: string; readonly frame: CoinbaseHeartbeatsFrame }
  /**
   * A recognized non-market-data frame: the `subscriptions` acknowledgement.
   *
   * Its payload shape is UNVERIFIED (U-CB-5), so only the common envelope is
   * parsed. It still counts for sequence continuity, because it carries
   * `sequence_num` like every other message.
   */
  | { readonly kind: "CONTROL"; readonly text: string; readonly frame: CoinbaseFrameEnvelope }
  /**
   * A well-formed envelope on a channel this adapter does not handle.
   *
   * A first-class UNKNOWN, not an error (ADR-002 §7): the venue states that new
   * message types appear at any time, and treating the channel list as closed
   * would make a routine venue addition look like corruption. It is still
   * reported, because §8.3 does not permit ignoring it either.
   */
  | {
      readonly kind: "UNKNOWN_CHANNEL";
      readonly text: string;
      readonly frame: CoinbaseFrameEnvelope;
    }
  | {
      readonly kind: "REJECTED";
      readonly rejection: CoinbaseFrameRejection;
      readonly detail: string;
      /** The frame as received, when it was text. */
      readonly text?: string;
      /** Byte length, when it was not text and therefore has no faithful text form. */
      readonly byteLength?: number;
    };

/**
 * Classifies one raw frame.
 *
 * @returns exactly one classification; never throws, never returns `undefined`.
 */
export function classifyFrame(raw: CoinbaseRawFrame): CoinbaseClassifiedFrame {
  if (typeof raw !== "string") {
    return ownEmit<CoinbaseClassifiedFrame>({
      kind: "REJECTED",
      rejection: "NOT_TEXT",
      detail:
        `received a ${raw.byteLength}-byte binary frame; the Coinbase feed is documented as ` +
        "JSON text and the raw-frame format cannot hold binary (ADR-004 §1)",
      byteLength: raw.byteLength,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    return ownEmit<CoinbaseClassifiedFrame>({
      kind: "REJECTED",
      rejection: "NOT_JSON",
      detail: `frame is not JSON: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        1000,
      ),
      text: raw,
    });
  }

  // D1. Before a schema runs and before any property is read: rebuild the
  // frame as own data with no prototype, at every level.
  const read = readOwnFrame(parsed);
  if (!read.ok) {
    return rejectShape(raw, `frame could not be read as JSON data: ${read.detail}`);
  }
  const frame: unknown = read.value;

  const envelope = containedParse(CoinbaseFrameEnvelopeSchema, frame);
  if (!envelope.ok) {
    return rejectShape(raw, `frame is not a documented Coinbase envelope: ${envelope.detail}`);
  }
  // D3, AND the routing decision itself. `channel` is what puts a frame in a
  // recorded dataset, `sequence_num` is what gap detection is built on, and
  // `timestamp` is the venue's send time: all three are read from the
  // materialized tree by this module, not taken from `parsed.data`.
  if (!isOwnRecord(frame)) {
    return rejectShape(raw, ENVELOPE_NOT_OWNED);
  }
  const channel = ownNonEmptyString(frame, "channel");
  if (
    channel === undefined ||
    ownNonEmptyString(frame, "timestamp") === undefined ||
    ownSafeInt(frame, "sequence_num") === undefined
  ) {
    return rejectShape(raw, ENVELOPE_NOT_OWNED);
  }

  switch (channel) {
    case COINBASE_CHANNELS.marketTrades:
      return classified<CoinbaseMarketTradesFrame>(
        "MARKET_TRADES",
        raw,
        frame,
        CoinbaseMarketTradesFrameSchema,
        COINBASE_CHANNELS.marketTrades,
        TRADE_ENTRY_KEYS,
        "trades",
      );
    case COINBASE_CHANNELS.ticker:
      return classified<CoinbaseTickerFrame>(
        "TICKER",
        raw,
        frame,
        CoinbaseTickerFrameSchema,
        COINBASE_CHANNELS.ticker,
        TICKER_ENTRY_KEYS,
        "tickers",
      );
    case COINBASE_CHANNELS.heartbeats:
      return classified<CoinbaseHeartbeatsFrame>(
        "HEARTBEATS",
        raw,
        frame,
        CoinbaseHeartbeatsFrameSchema,
        COINBASE_CHANNELS.heartbeats,
        HEARTBEAT_EVENT_KEYS,
        undefined,
      );
    case COINBASE_CHANNELS.subscriptions:
      return ownEmit<CoinbaseClassifiedFrame>({
        kind: "CONTROL",
        text: raw,
        // The `subscriptions` payload shape is UNVERIFIED (U-CB-5), so only
        // the envelope is projected and `events` is carried verbatim, exactly
        // as `z.array(z.unknown())` did.
        frame: ownEnvelope(frame) as CoinbaseFrameEnvelope,
      });
    default:
      return ownEmit<CoinbaseClassifiedFrame>({
        kind: "UNKNOWN_CHANNEL",
        text: raw,
        frame: ownEnvelope(frame) as CoinbaseFrameEnvelope,
      });
  }
}

/**
 * The declared keys of each documented entry, IN SCHEMA ORDER.
 *
 * D3 with byte-identity: the emitted frame is projected from the materialized
 * tree onto exactly the shape `./wire.js` declares, in the order the schema
 * declares it, so an honest frame's classification is byte for byte what
 * `parsed.data` used to be — the door replaces where the values come from, not
 * what a consumer sees. `REC-1` measured this both ways over the whole fixture
 * catalogue.
 */
const ENVELOPE_KEYS = ["channel", "timestamp", "sequence_num"] as const;
const TICKER_ENTRY_KEYS = [
  "product_id",
  "best_bid",
  "best_ask",
  "best_bid_quantity",
  "best_ask_quantity",
] as const;
const TRADE_ENTRY_KEYS = ["trade_id", "product_id", "price", "size", "side", "time"] as const;
const HEARTBEAT_EVENT_KEYS = ["current_time", "heartbeat_counter"] as const;

/**
 * Picks `keys` from a materialized record, omitting the ones it does not carry.
 *
 * Built prototype-free and by `ownDefine` rather than by assignment: an
 * ordinary `out[key] = …` is a `Set`, and `Set` consults the prototype chain,
 * so an inherited setter could swallow the write and leave the key absent (the
 * LOSS class, `schema-boundary.md` §2). The spreads that consume this are
 * object-literal spreads, which create data properties directly.
 */
function pick(record: OwnRecord, keys: readonly string[]): Record<string, unknown> {
  const out = ownRecord();
  for (const key of keys) {
    if (Object.hasOwn(record, key)) {
      ownDefine(out, key, record[key]);
    }
  }
  return out;
}

/** The common envelope, projected; `events` is carried as declared. */
function ownEnvelope(frame: OwnRecord): unknown {
  return ownEmit({
    ...pick(frame, ENVELOPE_KEYS),
    ...(Object.hasOwn(frame, "events") ? { events: frame["events"] } : {}),
  });
}

/**
 * The detail a frame gets when `zod` accepted an envelope the frame does not
 * itself carry. Reachable only under prototype pollution, and fail-closed.
 */
const ENVELOPE_NOT_OWNED =
  "frame is not a documented Coinbase envelope: it does not carry `channel`, `timestamp` and `sequence_num` as its own values, and a frame is never routed by a channel it did not declare";

/**
 * Parses one channel's documented shape and emits the MATERIALIZED values.
 *
 * The cast is the door's own statement: the projection carries exactly the keys
 * the schema declares, in the order it declares them, taken from the tree the
 * schema just accepted.
 */
function classified<T>(
  kind: "MARKET_TRADES" | "TICKER" | "HEARTBEATS",
  text: string,
  frame: OwnRecord,
  schema: Parameters<typeof containedParse>[0],
  channel: string,
  entryKeys: readonly string[],
  entryListKey: "trades" | "tickers" | undefined,
): CoinbaseClassifiedFrame {
  const parsed = containedParse(schema, frame);
  if (!parsed.ok) {
    return rejectShape(
      text,
      `frame on channel ${channel} does not match its documented shape: ${parsed.detail}`,
    );
  }
  const events = frame["events"];
  const projected = ownEmit({
    ...pick(frame, ENVELOPE_KEYS),
    events: Array.isArray(events)
      ? events.map((event) => projectEvent(event, entryKeys, entryListKey))
      : events,
  });
  return ownEmit<CoinbaseClassifiedFrame>({ kind, text, frame: projected as T });
}

/**
 * One `events[]` member, projected onto its declared shape.
 *
 * The heartbeats event has no entry list and declares its two fields directly;
 * the other two declare `{ type, <list> }`.
 */
function projectEvent(
  event: unknown,
  entryKeys: readonly string[],
  entryListKey: "trades" | "tickers" | undefined,
): unknown {
  if (!isOwnRecord(event)) {
    return event;
  }
  if (entryListKey === undefined) {
    return ownEmit(pick(event, entryKeys));
  }
  const entries = event[entryListKey];
  return ownEmit({
    ...pick(event, ["type"]),
    [entryListKey]: Array.isArray(entries)
      ? entries.map((entry) => (isOwnRecord(entry) ? ownEmit(pick(entry, entryKeys)) : entry))
      : entries,
  });
}

function rejectShape(text: string, detail: string): CoinbaseClassifiedFrame {
  return ownEmit<CoinbaseClassifiedFrame>({
    kind: "REJECTED",
    rejection: "SHAPE",
    detail,
    text,
  });
}
