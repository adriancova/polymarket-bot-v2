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
 */

import { COINBASE_CHANNELS } from "./venue-facts.js";
import {
  CoinbaseFrameEnvelopeSchema,
  CoinbaseHeartbeatsFrameSchema,
  CoinbaseMarketTradesFrameSchema,
  CoinbaseTickerFrameSchema,
  describeParseFailure,
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
    return {
      kind: "REJECTED",
      rejection: "NOT_TEXT",
      detail:
        `received a ${raw.byteLength}-byte binary frame; the Coinbase feed is documented as ` +
        "JSON text and the raw-frame format cannot hold binary (ADR-004 §1)",
      byteLength: raw.byteLength,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    return {
      kind: "REJECTED",
      rejection: "NOT_JSON",
      detail: `frame is not JSON: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        1000,
      ),
      text: raw,
    };
  }

  const envelope = CoinbaseFrameEnvelopeSchema.safeParse(parsed);
  if (!envelope.success) {
    return {
      kind: "REJECTED",
      rejection: "SHAPE",
      detail: `frame is not a documented Coinbase envelope: ${describeParseFailure(envelope.error)}`,
      text: raw,
    };
  }

  switch (envelope.data.channel) {
    case COINBASE_CHANNELS.marketTrades: {
      const frame = CoinbaseMarketTradesFrameSchema.safeParse(parsed);
      return frame.success
        ? { kind: "MARKET_TRADES", text: raw, frame: frame.data }
        : rejectShape(raw, COINBASE_CHANNELS.marketTrades, frame.error);
    }
    case COINBASE_CHANNELS.ticker: {
      const frame = CoinbaseTickerFrameSchema.safeParse(parsed);
      return frame.success
        ? { kind: "TICKER", text: raw, frame: frame.data }
        : rejectShape(raw, COINBASE_CHANNELS.ticker, frame.error);
    }
    case COINBASE_CHANNELS.heartbeats: {
      const frame = CoinbaseHeartbeatsFrameSchema.safeParse(parsed);
      return frame.success
        ? { kind: "HEARTBEATS", text: raw, frame: frame.data }
        : rejectShape(raw, COINBASE_CHANNELS.heartbeats, frame.error);
    }
    case COINBASE_CHANNELS.subscriptions:
      return { kind: "CONTROL", text: raw, frame: envelope.data };
    default:
      return { kind: "UNKNOWN_CHANNEL", text: raw, frame: envelope.data };
  }
}

function rejectShape(
  text: string,
  channel: string,
  error: Parameters<typeof describeParseFailure>[0],
): CoinbaseClassifiedFrame {
  return {
    kind: "REJECTED",
    rejection: "SHAPE",
    detail: `frame on channel ${channel} does not match its documented shape: ${describeParseFailure(error)}`,
    text,
  };
}
