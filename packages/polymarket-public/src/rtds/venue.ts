/**
 * The RTDS wire shapes, as zod schemas.
 *
 * Source: https://docs.polymarket.com/market-data/chainlink-twap (accessed
 * 2026-08-28). The direct-RTDS example, verbatim:
 *
 * ```json
 * {
 *   "topic": "crypto_prices_twap_thirty",
 *   "type": "update",
 *   "timestamp": 1785178800123,
 *   "payload": {
 *     "symbol": "btc/usd",
 *     "value": 65000.5,
 *     "full_accuracy_value": "65000500000000000000000",
 *     "timestamp": 1785178800000,
 *     "window_s": 30
 *   }
 * }
 * ```
 *
 * ## Two surfaces, one page — and this adapter reads the lower one
 *
 * The same page also documents a `@polymarket/client` subscription whose events
 * look different: topic `prices.crypto.chainlink.twap`, `payload.windowSeconds`,
 * and `payload.value` as a `DecimalString`. That is the SDK's own normalized
 * shape, reachable only through `@polymarket/client`, which F6 grants
 * exclusively to `packages/polymarket-secure`
 * (`docs/contracts/dependency-direction.md` §3). This adapter is a "direct
 * client" in the page's sense and models ONLY the raw RTDS frames above. The two
 * must not be confused: the raw frame's `value` is a floating JSON number and is
 * never read for economics (ADR-001 §8.3).
 *
 * ## Strictness: structure here, meaning in `./values.ts`
 *
 * These schemas judge SHAPE. Whether a decimal is canonical, whether an instant
 * is in range, and whether the window agrees with the topic are semantic
 * questions answered in `./values.ts` and `./normalize.ts`, where a failure
 * becomes a typed problem carrying the raw value rather than a parse error with
 * no evidence.
 *
 * Unknown keys are STRIPPED rather than rejected. A frozen fixture catalog may
 * be strict about undocumented keys; a runtime parser that rejected a frame
 * because the venue added a field would drop valid traffic
 * (`docs/contracts/protected-contracts.md` §9, ADR-002 §7). Nothing is lost by
 * stripping: the raw frame is handed to the recorder before parsing (§9.1), and
 * every problem carries the raw value.
 */

import { z } from "zod";

import { RTDS_UPDATE_TYPE } from "./config.js";

/**
 * The inner update payload.
 *
 * - `symbol` — documented as a lowercase slash-delimited pair. Typed as a bare
 *   string: no symbol enumeration or grammar is published (RTDS-U4), and the
 *   domain's own `NonEmptyStringSchema` bound is applied at the boundary.
 * - `full_accuracy_value` — "the exact signed E18 fixed-point value". Required,
 *   and required to be a STRING: a JSON number cannot carry a 23-digit integer
 *   exactly, and this is the only field the exact-decimal path may read
 *   (ADR-001 §8.3).
 * - `timestamp` — "the Chainlink observation time". Required; every epoch-like
 *   form the SDK accepts is accepted at the value boundary.
 * - `window_s` — the lookback window in seconds. Required, and cross-checked
 *   against the topic in `./normalize.ts`: a payload that disagrees with its own
 *   topic is a contradiction, not something to resolve by preferring one side.
 * - `value` — "provided only for display convenience". Accepted in any form and
 *   NEVER read. It is declared here so the shape is documented, and typed
 *   `unknown` so a change in its encoding cannot reject an otherwise valid
 *   update.
 */
export const RtdsTwapUpdatePayloadSchema = z.object({
  symbol: z.string(),
  full_accuracy_value: z.string(),
  timestamp: z.union([z.number(), z.string()]),
  window_s: z.number(),
  value: z.unknown().optional(),
});

export type RtdsTwapUpdatePayload = z.infer<typeof RtdsTwapUpdatePayloadSchema>;

/**
 * The envelope every RTDS message shares.
 *
 * The outer `timestamp` is "when the publisher submitted the update to RTDS",
 * which is a different fact from the payload's Chainlink observation time and is
 * carried separately (as `venueTimestamp` provenance). It is OPTIONAL and
 * nullable here because the page's own Python type declares
 * `timestamp: datetime | None`; an absent or null publisher timestamp is
 * therefore documented traffic, not a defect.
 */
export const RtdsEnvelopeSchema = z.object({
  topic: z.string(),
  type: z.string(),
  timestamp: z.union([z.number(), z.string()]).nullish(),
  /**
   * OPTIONAL at the envelope level, and required at the payload level.
   *
   * Not a looseness about update frames — an update without a payload is
   * refused a few lines later, as `RTDS_INVALID_TWAP_PAYLOAD`. It is about
   * classification order: if the envelope demanded a payload, a hypothetical
   * payload-less RTDS control frame would be reported as a malformed envelope
   * instead of by its topic and type, which is strictly less informative about
   * what the venue actually sent.
   */
  payload: z.unknown().optional(),
});

export type RtdsEnvelope = z.infer<typeof RtdsEnvelopeSchema>;

/** Whether an envelope's `type` is the documented `update`. */
export function isUpdateEnvelope(envelope: RtdsEnvelope): boolean {
  return envelope.type === RTDS_UPDATE_TYPE;
}
