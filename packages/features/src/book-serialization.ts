/**
 * Reader for the canonical order-book serialization, version
 * `polymarket-bot/order-book/v1` (WP-150's `serializeBook`).
 *
 * WP-150's carried follow-up binds this package: snapshots must NOT invent a
 * second canonical serialization for book state. So book state enters the
 * feature engine AS that serialization — the caller passes `serializeBook(book)`
 * verbatim — and this module is a fail-closed READER of the format, not a
 * second writer. The exact bytes read are what the feature snapshot
 * content-addresses (`bookSha256`), so the addressed state and the computed
 * state cannot disagree.
 *
 * The features package cannot import `packages/order-book` itself: both are
 * layer 1, and the machine-checked dependency contract
 * (`docs/contracts/dependency-direction.md` §2.1, F13) enumerates no such
 * same-layer edge. The format is therefore consumed as DATA under its version
 * line — precisely what the version line is for — and
 * `test/unit/features/book-serialization-crosscheck.test.ts` binds this reader
 * to the real `serializeBook` output over live `OutcomeTokenBook` instances,
 * so drift between writer and reader fails a test rather than shipping.
 *
 * Everything is validated, and the redundant summary lines (best bid/ask,
 * spread, depth) are RECOMPUTED from the ladders and compared: a serialization
 * that disagrees with itself is refused, never partially trusted.
 */

import {
  addDecimal,
  compareDecimal,
  isCanonicalDecimalString,
  subDecimal,
} from "@polymarket-bot/decimal";
import type { DecimalString } from "@polymarket-bot/decimal";

import {
  compareCanonicalUnitInterval,
  isAtMostOneCanonical,
  isPositiveCanonical,
} from "./canonical-order.js";

/** The version line this reader accepts. Kept as data; pinned by cross-test. */
export const SUPPORTED_BOOK_SERIALIZATION_VERSION = "polymarket-bot/order-book/v1";

const ABSENT_MARKER = "-";

/** Canonical lowercase UUID (any RFC 9562 version) — the gateway-epoch grammar. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Canonical unsigned integer string (no leading zeros). */
const UNSIGNED_INTEGER_PATTERN = /^(?:0|[1-9][0-9]*)$/u;

export interface ParsedBookLevel {
  readonly price: DecimalString;
  readonly size: DecimalString;
}

/** The reconstructed book state the v1 serialization carries. */
export interface ParsedBook {
  readonly internalMarketId: string;
  readonly tokenId: string;
  readonly gatewayEpoch: string;
  readonly subscriptionGeneration: number;
  readonly lastIngestSeq: string;
  readonly venueBookHash?: string;
  readonly tickSize?: DecimalString;
  /** Descending by price, as serialized. */
  readonly bids: readonly ParsedBookLevel[];
  /** Ascending by price, as serialized. */
  readonly asks: readonly ParsedBookLevel[];
}

export type BookReadProblemKind = "UNSUPPORTED_VERSION" | "MALFORMED" | "INCONSISTENT" | "NOT_BASELINED";

export type BookRead =
  | { readonly ok: true; readonly book: ParsedBook }
  | { readonly ok: false; readonly kind: BookReadProblemKind; readonly problem: string };

function malformed(problem: string): BookRead {
  return { ok: false, kind: "MALFORMED", problem };
}

function inconsistent(problem: string): BookRead {
  return { ok: false, kind: "INCONSISTENT", problem };
}

/** A price is a probability: canonical, in `[0, 1]`. */
function isPrice(value: string): value is DecimalString {
  // `THROUGHPUT-1a`: the range check is `canonical-order.ts`'s exact string
  // answer to `compareDecimal(value, "1") <= 0`, valid once the value is
  // known canonical and non-negative (checked first).
  return (
    isCanonicalDecimalString(value) &&
    !value.startsWith("-") &&
    isAtMostOneCanonical(value)
  );
}

/** A resting size is canonical and strictly positive (the book never stores zero). */
function isPositiveSize(value: string): value is DecimalString {
  // `THROUGHPUT-1a`: exactly `compareDecimal(value, "0") > 0` on a canonical,
  // non-negative value (`canonical-order.ts`).
  return isCanonicalDecimalString(value) && !value.startsWith("-") && isPositiveCanonical(value);
}

interface LadderRead {
  readonly ok: boolean;
  readonly levels: ParsedBookLevel[];
  readonly problem?: string;
}

function readLadder(
  lines: readonly string[],
  start: number,
  count: number,
  side: "bids" | "asks",
): LadderRead {
  const levels: ParsedBookLevel[] = [];
  for (let index = 0; index < count; index += 1) {
    const line = lines[start + index];
    if (line === undefined) {
      return { ok: false, levels, problem: `${side}: declared ${String(count)} levels but the text ends early` };
    }
    const parts = line.split(" ");
    if (parts.length !== 2) {
      return { ok: false, levels, problem: `${side}[${String(index)}]: a level line must be "<price> <size>"` };
    }
    const [price, size] = parts as [string, string];
    if (!isPrice(price)) {
      return { ok: false, levels, problem: `${side}[${String(index)}]: price ${JSON.stringify(price)} is not a canonical probability in [0, 1]` };
    }
    if (!isPositiveSize(size)) {
      return { ok: false, levels, problem: `${side}[${String(index)}]: size ${JSON.stringify(size)} is not a positive canonical decimal (a stored level is never zero)` };
    }
    const last = levels[levels.length - 1];
    if (last !== undefined) {
      // `THROUGHPUT-1a`: both are validated prices (canonical, in [0, 1]), so
      // their code-unit order IS `compareDecimal`'s (`canonical-order.ts`).
      const order = compareCanonicalUnitInterval(price, last.price);
      if (order === 0) {
        return { ok: false, levels, problem: `${side}[${String(index)}]: duplicate price ${price}` };
      }
      if (side === "bids" ? order > 0 : order < 0) {
        return {
          ok: false,
          levels,
          problem: `${side}[${String(index)}]: prices must be ${side === "bids" ? "strictly descending" : "strictly ascending"}`,
        };
      }
    }
    levels.push({ price, size });
  }
  return { ok: true, levels };
}

/** The rest of `line` after a required literal prefix, or `undefined`. */
function after(line: string | undefined, prefix: string): string | undefined {
  if (line === undefined || !line.startsWith(prefix)) return undefined;
  return line.slice(prefix.length);
}

function levelCount(raw: string | undefined, label: string): number | BookRead {
  if (raw === undefined || !UNSIGNED_INTEGER_PATTERN.test(raw)) {
    return malformed(`${label} count line is missing or not a canonical unsigned integer`);
  }
  const count = Number(raw);
  if (!Number.isSafeInteger(count)) {
    return malformed(`${label} count is not a safe integer`);
  }
  return count;
}

/**
 * Reads one v1 book serialization, byte-for-byte strict. Pure and total.
 *
 * Refuses: an unknown version line; any structural deviation from the v1 line
 * grammar; internal contradiction between the summary lines and the ladders;
 * and a book with no baseline (`epoch -`) — §7.1 requires an authoritative
 * snapshot before a book is state at all, so features are never computed over
 * an unbaselined book.
 */
export function readBookSerialization(text: string): BookRead {
  const lines = text.split("\n");
  if (lines[0] !== SUPPORTED_BOOK_SERIALIZATION_VERSION) {
    return {
      ok: false,
      kind: "UNSUPPORTED_VERSION",
      problem: `the first line is ${JSON.stringify(lines[0] ?? "")}, not ${JSON.stringify(SUPPORTED_BOOK_SERIALIZATION_VERSION)}`,
    };
  }

  const internalMarketId = after(lines[1], "market ");
  if (internalMarketId === undefined || internalMarketId.length === 0) {
    return malformed("line 2 must be \"market <internalMarketId>\"");
  }
  const tokenId = after(lines[2], "token ");
  if (tokenId === undefined || !UNSIGNED_INTEGER_PATTERN.test(tokenId)) {
    return malformed("line 3 must be \"token <canonical unsigned integer>\"");
  }
  const epoch = after(lines[3], "epoch ");
  if (epoch === undefined) {
    return malformed("line 4 must be \"epoch <uuid|->\"");
  }
  const generationRaw = after(lines[4], "generation ");
  if (generationRaw === undefined) {
    return malformed("line 5 must be \"generation <integer|->\"");
  }
  const lastIngestSeqRaw = after(lines[5], "lastIngestSeq ");
  if (lastIngestSeqRaw === undefined) {
    return malformed("line 6 must be \"lastIngestSeq <unsigned bigint|->\"");
  }
  const venueBookHashRaw = after(lines[6], "venueBookHash ");
  if (venueBookHashRaw === undefined || venueBookHashRaw.length === 0) {
    return malformed("line 7 must be \"venueBookHash <hash|->\"");
  }
  const tickSizeRaw = after(lines[7], "tickSize ");
  if (tickSizeRaw === undefined) {
    return malformed("line 8 must be \"tickSize <decimal|->\"");
  }
  const bestBidRaw = after(lines[8], "bestBid ");
  const bestAskRaw = after(lines[9], "bestAsk ");
  const spreadRaw = after(lines[10], "spread ");
  const depthRaw = after(lines[11], "depth bids ");
  if (bestBidRaw === undefined || bestAskRaw === undefined || spreadRaw === undefined || depthRaw === undefined) {
    return malformed("lines 9-12 must be the bestBid / bestAsk / spread / depth summary");
  }

  // The baseline identity: all three present, or all three absent.
  const baselineAbsent =
    epoch === ABSENT_MARKER && generationRaw === ABSENT_MARKER && lastIngestSeqRaw === ABSENT_MARKER;
  const baselinePresent =
    epoch !== ABSENT_MARKER && generationRaw !== ABSENT_MARKER && lastIngestSeqRaw !== ABSENT_MARKER;
  if (!baselineAbsent && !baselinePresent) {
    return inconsistent("epoch, generation and lastIngestSeq must be all present or all absent");
  }
  if (baselineAbsent) {
    return {
      ok: false,
      kind: "NOT_BASELINED",
      problem:
        "the book has no baseline snapshot (epoch -); §7.1 requires an authoritative snapshot before affected markets resume, so features are not computed over it",
    };
  }
  if (!UUID_PATTERN.test(epoch)) {
    return malformed("epoch is not a canonical lowercase UUID");
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(generationRaw)) {
    return malformed("generation is not a canonical unsigned integer");
  }
  const subscriptionGeneration = Number(generationRaw);
  if (!Number.isSafeInteger(subscriptionGeneration)) {
    return malformed("generation is not a safe integer");
  }
  if (!UNSIGNED_INTEGER_PATTERN.test(lastIngestSeqRaw) || lastIngestSeqRaw.length > 40) {
    return malformed("lastIngestSeq is not a canonical unsigned bigint string");
  }
  const tickSize = tickSizeRaw === ABSENT_MARKER ? undefined : tickSizeRaw;
  if (tickSize !== undefined && (!isCanonicalDecimalString(tickSize) || compareDecimal(tickSize, "0") <= 0)) {
    return malformed("tickSize is not a positive canonical decimal");
  }

  const bidCount = levelCount(after(lines[12], "bids "), "bids");
  if (typeof bidCount !== "number") return bidCount;
  const bidsRead = readLadder(lines, 13, bidCount, "bids");
  if (!bidsRead.ok) return malformed(bidsRead.problem ?? "bids ladder is malformed");
  const askCountLine = 13 + bidCount;
  const askCount = levelCount(after(lines[askCountLine], "asks "), "asks");
  if (typeof askCount !== "number") return askCount;
  const asksRead = readLadder(lines, askCountLine + 1, askCount, "asks");
  if (!asksRead.ok) return malformed(asksRead.problem ?? "asks ladder is malformed");
  if (lines.length !== askCountLine + 1 + askCount) {
    return malformed("trailing content after the asks ladder");
  }

  // ---- cross-checks: the summary lines must agree with the ladders ---------
  const bids = bidsRead.levels;
  const asks = asksRead.levels;
  const bestBid = bids[0];
  const bestAsk = asks[0];
  const expectedBestBid = `${bestBid?.price ?? ABSENT_MARKER} ${bestBid?.size ?? ABSENT_MARKER}`;
  if (bestBidRaw !== expectedBestBid) {
    return inconsistent(`bestBid line ${JSON.stringify(bestBidRaw)} disagrees with the bids ladder (${JSON.stringify(expectedBestBid)})`);
  }
  const expectedBestAsk = `${bestAsk?.price ?? ABSENT_MARKER} ${bestAsk?.size ?? ABSENT_MARKER}`;
  if (bestAskRaw !== expectedBestAsk) {
    return inconsistent(`bestAsk line ${JSON.stringify(bestAskRaw)} disagrees with the asks ladder (${JSON.stringify(expectedBestAsk)})`);
  }
  const expectedSpread =
    bestBid !== undefined && bestAsk !== undefined ? subDecimal(bestAsk.price, bestBid.price) : ABSENT_MARKER;
  if (spreadRaw !== expectedSpread) {
    return inconsistent(`spread line ${JSON.stringify(spreadRaw)} disagrees with the ladders (${JSON.stringify(expectedSpread)})`);
  }
  let bidShares: DecimalString = "0";
  for (const level of bids) bidShares = addDecimal(bidShares, level.size);
  let askShares: DecimalString = "0";
  for (const level of asks) askShares = addDecimal(askShares, level.size);
  const expectedDepth = `${String(bids.length)} ${bidShares} asks ${String(asks.length)} ${askShares}`;
  if (depthRaw !== expectedDepth) {
    return inconsistent(`depth line ${JSON.stringify(depthRaw)} disagrees with the ladders (${JSON.stringify(`depth bids ${expectedDepth}`)})`);
  }
  // A CROSSED book (best bid >= best ask) is NOT refused: the order-book
  // package stores and serializes such transient states faithfully, and this
  // reader mirrors its semantics rather than inventing stricter ones. The
  // derived spread is simply negative or zero, exactly as serialized.

  return {
    ok: true,
    book: {
      internalMarketId,
      tokenId,
      gatewayEpoch: epoch,
      subscriptionGeneration,
      lastIngestSeq: lastIngestSeqRaw,
      ...(venueBookHashRaw === ABSENT_MARKER ? {} : { venueBookHash: venueBookHashRaw }),
      ...(tickSize === undefined ? {} : { tickSize }),
      bids,
      asks,
    },
  };
}
