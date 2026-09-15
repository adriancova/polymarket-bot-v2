/**
 * The JSON bytes this package WRITES to a transport — subscription frames and
 * the REST request body — encoded from own data (`SER-3`, 2026-09-15).
 *
 * ## The route this closes
 *
 * `JSON.stringify` resolves `toJSON` through the value's PROTOTYPE CHAIN, so
 * an inherited `toJSON` on `Object.prototype` or `Array.prototype` (plain
 * assignment or a non-enumerable `defineProperty`) replaces the bytes of ANY
 * object and ANY array. Measured at `main` `d6e05bf` and reproduced
 * independently (`docs/handoffs/SER-0-sweep.md`,
 * `rtds-subscribe-frame-root-and-array`, `clob-market-frames-root-and-assets-array`,
 * `clob-rest-books-post-body`):
 *
 * ```text
 * rtds/feed.ts        the subscribe frame   under Object.prototype the bytes sent were the bare
 *                                           string "POLLUTED"; under Array.prototype
 *                                           {"action":"subscribe","subscriptions":"POLLUTED"};
 *                                           re-sent on EVERY reconnect; FeedConnected published
 *                                           with an advanced generation; nothing refused
 * feed/connection.ts  subscribe/unsubscribe the same shape for the initial frame, the dynamic
 *                                           subscribe and the unsubscribe — the assets_ids array
 *                                           collapses to "POLLUTED" and the unsubscribe path
 *                                           never refuses anything
 * runtime.ts          the POST /books body  the root IS an array, so both routes replace the
 *                                           whole body
 * ```
 *
 * Every hijackable container is one this package builds itself (a frame
 * literal, an `assets_ids` copy, the fetcher's `[{ token_id }]` array); no
 * caller has to supply anything. The venue then receives a subscription to
 * nothing, or a body it cannot read, from a feed that reports itself connected.
 *
 * ## What this module is
 *
 * A thin adapter over `@polymarket-bot/risk/plain-json`'s `encodePlainJson`
 * (the canonical own-data restatement of ECMA-262 25.5.2; byte-identical to a
 * clean `JSON.stringify` for plain data, never consults `toJSON`). The edge is
 * `packages/polymarket-public` (layer 2) → `packages/risk` (layer 1),
 * downward, so no `dependency-direction.md` §2.1 row is involved.
 *
 * A refusal is restated in THIS package's vocabulary. Every frame and body is
 * a pure function of validated options and caller-supplied token ids, so a
 * value the encoder cannot represent — a bigint, a function, a `Date`, an
 * accessor, a non-plain container — is a contract breach by the caller that
 * built it, which is what `PUBLIC_MARKET_CONFIGURATION` names ("adapter
 * options are self-contradictory, out of range, or name a bad endpoint"). It
 * is thrown, never skipped: a frame silently not sent is a subscription the
 * feed believes it holds (handoff §8.3).
 *
 * The refusal is classified by an OWN-DATA read of its `kind` — never
 * `instanceof`, which walks the thrown value's prototype chain — following
 * `packages/event-bus/src/envelope-door.ts`. A thrown value that does not
 * classify is re-thrown as itself.
 */

import { encodePlainJson, PLAIN_JSON_REFUSAL_KINDS } from "@polymarket-bot/risk/plain-json";
import type { PlainJsonRefusalKind } from "@polymarket-bot/risk/plain-json";

import { PublicMarketConfigurationError } from "./errors.js";

/**
 * The JSON text of `value`, read as own data only; exactly the bytes
 * `JSON.stringify(value)` returns in a clean process for plain data.
 *
 * `what` names the artifact in the refusal (`"RTDS subscribe frame"`,
 * `"market subscription frame"`, `"REST request body"`) so an operator reads
 * which outbound byte string could not be built.
 *
 * @throws {PublicMarketConfigurationError} when `value` is not plain JSON data.
 */
export function encodeOutboundJson(value: unknown, what: string): string {
  try {
    return encodePlainJson(value);
  } catch (error) {
    const kind = plainJsonRefusalKind(error);
    if (kind === undefined) throw error;
    throw new PublicMarketConfigurationError(
      `the ${what} is not plain JSON data and was not sent`,
      {
        what,
        kind,
        path: ownString(error, "path"),
        problem: ownString(error, "problem"),
      },
    );
  }
}

/**
 * The `kind` of the canonical encoder's refusal, read as OWN DATA. TOTAL: a
 * value that is not an object, carries no own data `kind`, or throws from the
 * descriptor read (a `Proxy` trap) is `undefined`.
 */
function plainJsonRefusalKind(error: unknown): PlainJsonRefusalKind | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "kind");
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
    const kind: unknown = descriptor.value;
    return typeof kind === "string" && PLAIN_JSON_REFUSAL_KINDS.includes(kind as PlainJsonRefusalKind)
      ? (kind as PlainJsonRefusalKind)
      : undefined;
  } catch {
    return undefined;
  }
}

/** An own string-valued data property of `error`, or `undefined`. */
function ownString(error: unknown, key: string): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
    return typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
