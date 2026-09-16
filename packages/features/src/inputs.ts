/**
 * The v1 feature-input contract, validated by hand over the materialized tree.
 *
 * NO SCHEMA LIBRARY RUNS HERE. Per the recorded cross-package schema risk
 * (see `materialize.ts`), every predicate below is a total, hand-written check
 * over the prototype-free tree `materializeInput` produced, and every value
 * the engine computes from is taken from that tree. There are NO defaults:
 * every correctness-relevant setting (depth levels, executable quantities,
 * trade window, EWMA lambda, primary venue) is a REQUIRED explicit field, so
 * no absent field can silently become a value.
 *
 * Structure is STRICT: an unknown key anywhere is refused, because a misspelt
 * optional section that silently validates is a feature quietly computing
 * without its input.
 *
 * Grammar sources (mirrored, and bound to the frozen domain contracts by
 * `test/unit/features/grammar-crosscheck.test.ts` rather than by importing
 * their zod schemas at runtime):
 * - `InternalMarketId`: lowercase canonical UUIDv7 (§7.2).
 * - `TokenId`: canonical unsigned integer string (§7.2).
 * - `gatewayEpoch`: lowercase canonical UUID; `ingestSeq`: unsigned bigint
 *   string ≤ 40 chars (§7.1).
 * - decimals: the frozen §7.3 canonical grammar via `@polymarket-bot/decimal`.
 * - codes (`feedId`, `reasonCode`): the domain `CodeStringSchema` grammar.
 * - timestamps: the strict v1 UTC subset (`time.ts`) of the domain ISO grammar.
 *
 * ## Temporal rules (§6 invariant 15: information-arrival order)
 *
 * - Every VALUE-BEARING observation (a trade, a reference price, a TWAP
 *   window end) must be at or before `asOf`; a future observation is refused,
 *   because features computed from it would use information the live process
 *   could not have had.
 * - Feed `lastEventAt` stamps are DIAGNOSTIC (they become ages) and may sit
 *   after `asOf`; the age is then negative and reported as-is, mirroring the
 *   order-book package's never-clamped staleness rule.
 */

import { compareDecimal, isCanonicalDecimalString } from "@polymarket-bot/decimal";
import type { DecimalString } from "@polymarket-bot/decimal";
// TYPE-ONLY imports from the frozen domain contracts: the vocabularies below
// are the domain's, and binding them at the type level keeps this package's
// hand-rolled runtime validation (see the module header) from drifting to a
// private dialect. No domain zod schema runs here.
import type { BookSide, IncidentSeverity } from "@polymarket-bot/domain";

import type { ParsedBook } from "./book-serialization.js";
import { readBookSerialization } from "./book-serialization.js";
import { ownPlainCopy } from "./materialize.js";
import { parseUtcTimestamp } from "./time.js";

// ---------------------------------------------------------------------------
// Bounds (all refusals, never truncation)
// ---------------------------------------------------------------------------

export const MAX_SERIALIZED_BOOK_LENGTH = 2_000_000;
export const MAX_TRADES = 10_000;
export const MAX_REFERENCE_POINTS = 10_000;
export const MAX_TWAPS = 100;
export const MAX_INCIDENTS = 1_000;
export const MAX_CONFIG_LIST = 16;
export const MAX_DEPTH_LEVEL = 1_000;
export const MAX_TRADE_WINDOW_MS = 86_400_000;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UNSIGNED_BIGINT_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
const CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_CODE_LENGTH = 64;

// ---------------------------------------------------------------------------
// Validated model
// ---------------------------------------------------------------------------

export interface ValidatedSubject {
  readonly internalMarketId: string;
  readonly tokenId: string;
}

export interface ValidatedTrigger {
  readonly gatewayEpoch: string;
  readonly ingestSeq: string;
  readonly eventId?: string;
}

export type ReferenceVenueName = "binance" | "coinbase";

export interface ValidatedConfig {
  readonly depthLevels: readonly number[];
  readonly executableShares: readonly DecimalString[];
  readonly tradeWindowMs: number;
  readonly ewmaLambda: DecimalString;
  readonly primaryReferenceVenue: ReferenceVenueName;
}

export interface ValidatedBookInput {
  readonly serializedBook: string;
  readonly lastEventAt: string;
  readonly lastEventAtEpochMs: number;
  readonly parsed: ParsedBook;
}

export interface ValidatedTrade {
  readonly price: DecimalString;
  readonly size: DecimalString;
  /** ADR-014 vocabulary: the aggressor order's own side. */
  readonly takerSide?: BookSide;
  readonly observedAt: string;
  readonly observedAtEpochMs: number;
}

export interface ValidatedTradesInput {
  readonly lastEventAt: string;
  readonly lastEventAtEpochMs: number;
  readonly window: readonly ValidatedTrade[];
}

export interface ValidatedReferencePoint {
  readonly price: DecimalString;
  readonly observedAt: string;
  readonly observedAtEpochMs: number;
}

export interface ValidatedReferenceTop {
  readonly bidPrice?: DecimalString;
  readonly bidSize?: DecimalString;
  readonly askPrice?: DecimalString;
  readonly askSize?: DecimalString;
}

export interface ValidatedReferenceSeries {
  readonly symbol: string;
  readonly lastEventAt: string;
  readonly lastEventAtEpochMs: number;
  readonly trades: readonly ValidatedReferencePoint[];
  readonly topOfBook?: ValidatedReferenceTop;
}

export interface ValidatedTwap {
  readonly feedId: string;
  readonly value: DecimalString;
  readonly windowSeconds: number;
  readonly windowEndAt: string;
  readonly windowEndAtEpochMs: number;
}

export interface ValidatedChainlinkInput {
  readonly lastEventAt: string;
  readonly lastEventAtEpochMs: number;
  readonly twaps: readonly ValidatedTwap[];
}

export interface ValidatedReferenceInput {
  readonly binance?: ValidatedReferenceSeries;
  readonly coinbase?: ValidatedReferenceSeries;
  readonly chainlink?: ValidatedChainlinkInput;
}

export interface ValidatedLifecycleInput {
  readonly openedAt?: string;
  readonly openedAtEpochMs?: number;
  readonly closesAt?: string;
  readonly closesAtEpochMs?: number;
  readonly referenceOpenPrice?: DecimalString;
}

export interface ValidatedIncident {
  readonly incidentId: string;
  readonly reasonCode: string;
  /** §14.4 alert vocabulary, the domain `IncidentSeverity`. */
  readonly severity: IncidentSeverity;
  readonly feedId?: string;
}

export interface ValidatedQualityInput {
  readonly activeIncidents: readonly ValidatedIncident[];
}

export interface ValidatedFeatureInput {
  readonly subject: ValidatedSubject;
  readonly asOf: string;
  readonly asOfEpochMs: number;
  readonly trigger: ValidatedTrigger;
  readonly config: ValidatedConfig;
  readonly book: ValidatedBookInput;
  readonly trades?: ValidatedTradesInput;
  readonly reference: ValidatedReferenceInput;
  readonly lifecycle?: ValidatedLifecycleInput;
  readonly quality: ValidatedQualityInput;
}

export interface InputProblem {
  readonly path: string;
  readonly problem: string;
}

export type InputValidation =
  | { readonly ok: true; readonly input: ValidatedFeatureInput }
  | {
      readonly ok: false;
      readonly kind:
        | "INVALID"
        | "TIMESTAMP"
        | "SUBJECT_MISMATCH"
        | "BOOK_UNSUPPORTED"
        | "BOOK_MALFORMED"
        | "BOOK_INCONSISTENT"
        | "BOOK_NOT_BASELINED";
      readonly problems: readonly InputProblem[];
    };

// ---------------------------------------------------------------------------
// Walk helpers over the materialized (prototype-free) tree
// ---------------------------------------------------------------------------

const MAX_PROBLEMS = 25;

class Ctx {
  readonly problems: InputProblem[] = [];
  kind: "INVALID" | "TIMESTAMP" = "INVALID";

  fail(path: string, problem: string): undefined {
    if (this.problems.length < MAX_PROBLEMS) {
      this.problems.push({ path, problem });
    }
    return undefined;
  }

  failTimestamp(path: string, problem: string): undefined {
    if (this.problems.length === 0) {
      this.kind = "TIMESTAMP";
    }
    return this.fail(path, problem);
  }
}

/** The materialized tree is prototype-free plain data; direct reads are own reads. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(ctx: Ctx, value: unknown, path: string, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return ctx.fail(path, "must be a record");
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      ctx.fail(`${path}.${key}`, "unknown key (the v1 input contract is strict)");
      return undefined;
    }
  }
  return value;
}

function requireArray(ctx: Ctx, value: unknown, path: string, maxLength: number): readonly unknown[] | undefined {
  if (!Array.isArray(value)) {
    return ctx.fail(path, "must be an array");
  }
  if (value.length > maxLength) {
    return ctx.fail(path, `carries ${String(value.length)} members; the v1 bound is ${String(maxLength)}`);
  }
  return value;
}

function requireString(ctx: Ctx, value: unknown, path: string, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return ctx.fail(path, "must be a non-empty string");
  }
  if (value.length > maxLength) {
    return ctx.fail(path, `longer than the ${String(maxLength)}-character bound`);
  }
  return value;
}

function requireTimestamp(ctx: Ctx, value: unknown, path: string): { readonly iso: string; readonly epochMs: number } | undefined {
  const parsed = parseUtcTimestamp(value);
  if (!parsed.ok) {
    return ctx.failTimestamp(path, parsed.problem);
  }
  return { iso: value as string, epochMs: parsed.epochMs };
}

function requirePositiveDecimal(ctx: Ctx, value: unknown, path: string): DecimalString | undefined {
  if (typeof value !== "string" || !isCanonicalDecimalString(value) || value.startsWith("-") || compareDecimal(value, "0") <= 0) {
    return ctx.fail(path, "must be a positive canonical decimal string (§7.3)");
  }
  return value;
}

function requireNonNegativeDecimal(ctx: Ctx, value: unknown, path: string): DecimalString | undefined {
  if (typeof value !== "string" || !isCanonicalDecimalString(value) || value.startsWith("-")) {
    return ctx.fail(path, "must be a non-negative canonical decimal string (§7.3)");
  }
  return value;
}

function requirePrice(ctx: Ctx, value: unknown, path: string): DecimalString | undefined {
  const decimal = requireNonNegativeDecimal(ctx, value, path);
  if (decimal === undefined) return undefined;
  if (compareDecimal(decimal, "1") > 0) {
    return ctx.fail(path, "an outcome-token price is a probability in [0, 1]");
  }
  return decimal;
}

function requireCode(ctx: Ctx, value: unknown, path: string): string | undefined {
  const raw = requireString(ctx, value, path, MAX_CODE_LENGTH);
  if (raw === undefined) return undefined;
  if (!CODE_PATTERN.test(raw)) {
    return ctx.fail(path, "must be an alphanumeric code without whitespace");
  }
  return raw;
}

function requirePositiveInteger(ctx: Ctx, value: unknown, path: string, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    return ctx.fail(path, "must be a positive safe integer");
  }
  if (value > max) {
    return ctx.fail(path, `exceeds the v1 bound of ${String(max)}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Section validators
// ---------------------------------------------------------------------------

function validateSubject(ctx: Ctx, value: unknown): ValidatedSubject | undefined {
  const record = requireRecord(ctx, value, "input.subject", ["internalMarketId", "tokenId"]);
  if (record === undefined) return undefined;
  const internalMarketId = requireString(ctx, record["internalMarketId"], "input.subject.internalMarketId", MAX_IDENTIFIER_LENGTH);
  const tokenId = requireString(ctx, record["tokenId"], "input.subject.tokenId", MAX_IDENTIFIER_LENGTH);
  if (internalMarketId === undefined || tokenId === undefined) return undefined;
  if (!UUID_V7_PATTERN.test(internalMarketId)) {
    return ctx.fail("input.subject.internalMarketId", "must be a lowercase canonical UUIDv7 (§7.2)");
  }
  if (!UNSIGNED_BIGINT_PATTERN.test(tokenId)) {
    return ctx.fail("input.subject.tokenId", "must be a canonical unsigned integer string (§7.2)");
  }
  return { internalMarketId, tokenId };
}

function validateTrigger(ctx: Ctx, value: unknown): ValidatedTrigger | undefined {
  const record = requireRecord(ctx, value, "input.trigger", ["gatewayEpoch", "ingestSeq", "eventId"]);
  if (record === undefined) return undefined;
  const gatewayEpoch = requireString(ctx, record["gatewayEpoch"], "input.trigger.gatewayEpoch", MAX_IDENTIFIER_LENGTH);
  const ingestSeq = requireString(ctx, record["ingestSeq"], "input.trigger.ingestSeq", 40);
  if (gatewayEpoch === undefined || ingestSeq === undefined) return undefined;
  if (!UUID_PATTERN.test(gatewayEpoch)) {
    return ctx.fail("input.trigger.gatewayEpoch", "must be a lowercase canonical UUID (§7.1)");
  }
  if (!UNSIGNED_BIGINT_PATTERN.test(ingestSeq)) {
    return ctx.fail("input.trigger.ingestSeq", "must be a canonical unsigned bigint string (§7.1)");
  }
  let eventId: string | undefined;
  if (record["eventId"] !== undefined) {
    eventId = requireString(ctx, record["eventId"], "input.trigger.eventId", MAX_IDENTIFIER_LENGTH);
    if (eventId === undefined) return undefined;
    if (!UUID_V7_PATTERN.test(eventId)) {
      return ctx.fail("input.trigger.eventId", "must be a lowercase canonical UUIDv7 (§7.1)");
    }
  }
  return { gatewayEpoch, ingestSeq, ...(eventId === undefined ? {} : { eventId }) };
}

function validateConfig(ctx: Ctx, value: unknown): ValidatedConfig | undefined {
  const record = requireRecord(ctx, value, "input.config", [
    "depthLevels",
    "executableShares",
    "tradeWindowMs",
    "ewmaLambda",
    "primaryReferenceVenue",
  ]);
  if (record === undefined) return undefined;

  const levelsRaw = requireArray(ctx, record["depthLevels"], "input.config.depthLevels", MAX_CONFIG_LIST);
  if (levelsRaw === undefined) return undefined;
  if (levelsRaw.length === 0) {
    return ctx.fail("input.config.depthLevels", "must name at least one level count (no defaults exist)");
  }
  const depthLevels: number[] = [];
  for (let index = 0; index < levelsRaw.length; index += 1) {
    const level = requirePositiveInteger(ctx, levelsRaw[index], `input.config.depthLevels[${String(index)}]`, MAX_DEPTH_LEVEL);
    if (level === undefined) return undefined;
    const last = depthLevels[depthLevels.length - 1];
    if (last !== undefined && level <= last) {
      return ctx.fail(`input.config.depthLevels[${String(index)}]`, "level counts must be strictly ascending");
    }
    depthLevels.push(level);
  }

  const sharesRaw = requireArray(ctx, record["executableShares"], "input.config.executableShares", MAX_CONFIG_LIST);
  if (sharesRaw === undefined) return undefined;
  if (sharesRaw.length === 0) {
    return ctx.fail("input.config.executableShares", "must name at least one quantity (no defaults exist)");
  }
  const executableShares: DecimalString[] = [];
  for (let index = 0; index < sharesRaw.length; index += 1) {
    const shares = requirePositiveDecimal(ctx, sharesRaw[index], `input.config.executableShares[${String(index)}]`);
    if (shares === undefined) return undefined;
    const last = executableShares[executableShares.length - 1];
    if (last !== undefined && compareDecimal(shares, last) <= 0) {
      return ctx.fail(`input.config.executableShares[${String(index)}]`, "quantities must be strictly ascending");
    }
    executableShares.push(shares);
  }

  const tradeWindowMs = requirePositiveInteger(ctx, record["tradeWindowMs"], "input.config.tradeWindowMs", MAX_TRADE_WINDOW_MS);
  if (tradeWindowMs === undefined) return undefined;

  const ewmaLambda = requirePositiveDecimal(ctx, record["ewmaLambda"], "input.config.ewmaLambda");
  if (ewmaLambda === undefined) return undefined;
  if (compareDecimal(ewmaLambda, "1") >= 0) {
    return ctx.fail("input.config.ewmaLambda", "must be strictly between 0 and 1");
  }

  const venue = record["primaryReferenceVenue"];
  if (venue !== "binance" && venue !== "coinbase") {
    return ctx.fail("input.config.primaryReferenceVenue", 'must be "binance" or "coinbase"');
  }

  return { depthLevels, executableShares, tradeWindowMs, ewmaLambda, primaryReferenceVenue: venue };
}

function validateTrades(ctx: Ctx, value: unknown, asOfEpochMs: number): ValidatedTradesInput | undefined {
  const record = requireRecord(ctx, value, "input.trades", ["lastEventAt", "window"]);
  if (record === undefined) return undefined;
  const lastEventAt = requireTimestamp(ctx, record["lastEventAt"], "input.trades.lastEventAt");
  const windowRaw = requireArray(ctx, record["window"], "input.trades.window", MAX_TRADES);
  if (lastEventAt === undefined || windowRaw === undefined) return undefined;

  const window: ValidatedTrade[] = [];
  for (let index = 0; index < windowRaw.length; index += 1) {
    const path = `input.trades.window[${String(index)}]`;
    const trade = requireRecord(ctx, windowRaw[index], path, ["price", "size", "takerSide", "observedAt"]);
    if (trade === undefined) return undefined;
    const price = requirePrice(ctx, trade["price"], `${path}.price`);
    const size = requirePositiveDecimal(ctx, trade["size"], `${path}.size`);
    const observedAt = requireTimestamp(ctx, trade["observedAt"], `${path}.observedAt`);
    if (price === undefined || size === undefined || observedAt === undefined) return undefined;
    const takerSideRaw = trade["takerSide"];
    let takerSide: "BID" | "ASK" | undefined;
    if (takerSideRaw !== undefined) {
      if (takerSideRaw !== "BID" && takerSideRaw !== "ASK") {
        return ctx.fail(`${path}.takerSide`, 'must be "BID" or "ASK" when present (ADR-014 vocabulary)');
      }
      takerSide = takerSideRaw;
    }
    if (observedAt.epochMs > asOfEpochMs) {
      return ctx.fail(`${path}.observedAt`, "is after asOf; features never consume information from the future (§6 invariant 15)");
    }
    const previous = window[window.length - 1];
    if (previous !== undefined && observedAt.epochMs < previous.observedAtEpochMs) {
      return ctx.fail(`${path}.observedAt`, "trades must be ordered by observedAt (ascending)");
    }
    window.push({
      price,
      size,
      ...(takerSide === undefined ? {} : { takerSide }),
      observedAt: observedAt.iso,
      observedAtEpochMs: observedAt.epochMs,
    });
  }
  return { lastEventAt: lastEventAt.iso, lastEventAtEpochMs: lastEventAt.epochMs, window };
}

function validateReferenceSeries(
  ctx: Ctx,
  value: unknown,
  path: string,
  asOfEpochMs: number,
): ValidatedReferenceSeries | undefined {
  const record = requireRecord(ctx, value, path, ["symbol", "lastEventAt", "trades", "topOfBook"]);
  if (record === undefined) return undefined;
  const symbol = requireString(ctx, record["symbol"], `${path}.symbol`, MAX_IDENTIFIER_LENGTH);
  const lastEventAt = requireTimestamp(ctx, record["lastEventAt"], `${path}.lastEventAt`);
  const tradesRaw = requireArray(ctx, record["trades"], `${path}.trades`, MAX_REFERENCE_POINTS);
  if (symbol === undefined || lastEventAt === undefined || tradesRaw === undefined) return undefined;

  const trades: ValidatedReferencePoint[] = [];
  for (let index = 0; index < tradesRaw.length; index += 1) {
    const pointPath = `${path}.trades[${String(index)}]`;
    const point = requireRecord(ctx, tradesRaw[index], pointPath, ["price", "observedAt"]);
    if (point === undefined) return undefined;
    const price = requirePositiveDecimal(ctx, point["price"], `${pointPath}.price`);
    const observedAt = requireTimestamp(ctx, point["observedAt"], `${pointPath}.observedAt`);
    if (price === undefined || observedAt === undefined) return undefined;
    if (observedAt.epochMs > asOfEpochMs) {
      return ctx.fail(`${pointPath}.observedAt`, "is after asOf; features never consume information from the future (§6 invariant 15)");
    }
    const previous = trades[trades.length - 1];
    if (previous !== undefined && observedAt.epochMs < previous.observedAtEpochMs) {
      return ctx.fail(`${pointPath}.observedAt`, "reference points must be ordered by observedAt (ascending)");
    }
    trades.push({ price, observedAt: observedAt.iso, observedAtEpochMs: observedAt.epochMs });
  }

  let topOfBook: ValidatedReferenceTop | undefined;
  if (record["topOfBook"] !== undefined) {
    const topPath = `${path}.topOfBook`;
    const top = requireRecord(ctx, record["topOfBook"], topPath, ["bidPrice", "bidSize", "askPrice", "askSize"]);
    if (top === undefined) return undefined;
    const out: {
      bidPrice?: DecimalString;
      bidSize?: DecimalString;
      askPrice?: DecimalString;
      askSize?: DecimalString;
    } = {};
    if (top["bidPrice"] !== undefined) {
      const bidPrice = requirePositiveDecimal(ctx, top["bidPrice"], `${topPath}.bidPrice`);
      if (bidPrice === undefined) return undefined;
      out.bidPrice = bidPrice;
    }
    if (top["bidSize"] !== undefined) {
      const bidSize = requireNonNegativeDecimal(ctx, top["bidSize"], `${topPath}.bidSize`);
      if (bidSize === undefined) return undefined;
      out.bidSize = bidSize;
    }
    if (top["askPrice"] !== undefined) {
      const askPrice = requirePositiveDecimal(ctx, top["askPrice"], `${topPath}.askPrice`);
      if (askPrice === undefined) return undefined;
      out.askPrice = askPrice;
    }
    if (top["askSize"] !== undefined) {
      const askSize = requireNonNegativeDecimal(ctx, top["askSize"], `${topPath}.askSize`);
      if (askSize === undefined) return undefined;
      out.askSize = askSize;
    }
    topOfBook = out;
  }

  return {
    symbol,
    lastEventAt: lastEventAt.iso,
    lastEventAtEpochMs: lastEventAt.epochMs,
    trades,
    ...(topOfBook === undefined ? {} : { topOfBook }),
  };
}

function validateChainlink(ctx: Ctx, value: unknown, asOfEpochMs: number): ValidatedChainlinkInput | undefined {
  const record = requireRecord(ctx, value, "input.reference.chainlink", ["lastEventAt", "twaps"]);
  if (record === undefined) return undefined;
  const lastEventAt = requireTimestamp(ctx, record["lastEventAt"], "input.reference.chainlink.lastEventAt");
  const twapsRaw = requireArray(ctx, record["twaps"], "input.reference.chainlink.twaps", MAX_TWAPS);
  if (lastEventAt === undefined || twapsRaw === undefined) return undefined;
  const twaps: ValidatedTwap[] = [];
  const seenTwaps = new Set<string>();
  for (let index = 0; index < twapsRaw.length; index += 1) {
    const path = `input.reference.chainlink.twaps[${String(index)}]`;
    const twap = requireRecord(ctx, twapsRaw[index], path, ["feedId", "value", "windowSeconds", "windowEndAt"]);
    if (twap === undefined) return undefined;
    const feedId = requireCode(ctx, twap["feedId"], `${path}.feedId`);
    const twapValue = requireNonNegativeDecimal(ctx, twap["value"], `${path}.value`);
    const windowSeconds = requirePositiveInteger(ctx, twap["windowSeconds"], `${path}.windowSeconds`, 86_400);
    const windowEndAt = requireTimestamp(ctx, twap["windowEndAt"], `${path}.windowEndAt`);
    if (feedId === undefined || twapValue === undefined || windowSeconds === undefined || windowEndAt === undefined) {
      return undefined;
    }
    if (windowEndAt.epochMs > asOfEpochMs) {
      return ctx.fail(`${path}.windowEndAt`, "is after asOf; features never consume information from the future (§6 invariant 15)");
    }
    const twapKey = `${feedId}|${String(windowSeconds)}|${windowEndAt.iso}`;
    if (seenTwaps.has(twapKey)) {
      return ctx.fail(path, "duplicate (feedId, windowSeconds, windowEndAt); the observation set is ambiguous");
    }
    seenTwaps.add(twapKey);
    twaps.push({
      feedId,
      value: twapValue,
      windowSeconds,
      windowEndAt: windowEndAt.iso,
      windowEndAtEpochMs: windowEndAt.epochMs,
    });
  }
  return { lastEventAt: lastEventAt.iso, lastEventAtEpochMs: lastEventAt.epochMs, twaps };
}

function validateReference(ctx: Ctx, value: unknown, asOfEpochMs: number): ValidatedReferenceInput | undefined {
  if (value === undefined) return {};
  const record = requireRecord(ctx, value, "input.reference", ["binance", "coinbase", "chainlink"]);
  if (record === undefined) return undefined;
  const out: { binance?: ValidatedReferenceSeries; coinbase?: ValidatedReferenceSeries; chainlink?: ValidatedChainlinkInput } = {};
  if (record["binance"] !== undefined) {
    const binance = validateReferenceSeries(ctx, record["binance"], "input.reference.binance", asOfEpochMs);
    if (binance === undefined) return undefined;
    out.binance = binance;
  }
  if (record["coinbase"] !== undefined) {
    const coinbase = validateReferenceSeries(ctx, record["coinbase"], "input.reference.coinbase", asOfEpochMs);
    if (coinbase === undefined) return undefined;
    out.coinbase = coinbase;
  }
  if (record["chainlink"] !== undefined) {
    const chainlink = validateChainlink(ctx, record["chainlink"], asOfEpochMs);
    if (chainlink === undefined) return undefined;
    out.chainlink = chainlink;
  }
  return out;
}

function validateLifecycle(ctx: Ctx, value: unknown): ValidatedLifecycleInput | undefined {
  const record = requireRecord(ctx, value, "input.lifecycle", ["openedAt", "closesAt", "referenceOpenPrice"]);
  if (record === undefined) return undefined;
  const out: {
    openedAt?: string;
    openedAtEpochMs?: number;
    closesAt?: string;
    closesAtEpochMs?: number;
    referenceOpenPrice?: DecimalString;
  } = {};
  if (record["openedAt"] !== undefined) {
    const openedAt = requireTimestamp(ctx, record["openedAt"], "input.lifecycle.openedAt");
    if (openedAt === undefined) return undefined;
    out.openedAt = openedAt.iso;
    out.openedAtEpochMs = openedAt.epochMs;
  }
  if (record["closesAt"] !== undefined) {
    const closesAt = requireTimestamp(ctx, record["closesAt"], "input.lifecycle.closesAt");
    if (closesAt === undefined) return undefined;
    out.closesAt = closesAt.iso;
    out.closesAtEpochMs = closesAt.epochMs;
  }
  if (out.openedAtEpochMs !== undefined && out.closesAtEpochMs !== undefined && out.closesAtEpochMs < out.openedAtEpochMs) {
    return ctx.fail("input.lifecycle.closesAt", "is before openedAt; a market cannot close before it opens");
  }
  if (record["referenceOpenPrice"] !== undefined) {
    const referenceOpenPrice = requirePositiveDecimal(ctx, record["referenceOpenPrice"], "input.lifecycle.referenceOpenPrice");
    if (referenceOpenPrice === undefined) return undefined;
    out.referenceOpenPrice = referenceOpenPrice;
  }
  return out;
}

const INCIDENT_SEVERITIES = ["LOG", "NOTIFY", "PAGE"] as const;

function validateQuality(ctx: Ctx, value: unknown): ValidatedQualityInput | undefined {
  const record = requireRecord(ctx, value, "input.quality", ["activeIncidents"]);
  if (record === undefined) return undefined;
  const incidentsRaw = requireArray(ctx, record["activeIncidents"], "input.quality.activeIncidents", MAX_INCIDENTS);
  if (incidentsRaw === undefined) return undefined;
  const incidents: ValidatedIncident[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < incidentsRaw.length; index += 1) {
    const path = `input.quality.activeIncidents[${String(index)}]`;
    const incident = requireRecord(ctx, incidentsRaw[index], path, ["incidentId", "reasonCode", "severity", "feedId"]);
    if (incident === undefined) return undefined;
    const incidentId = requireString(ctx, incident["incidentId"], `${path}.incidentId`, MAX_IDENTIFIER_LENGTH);
    const reasonCode = requireCode(ctx, incident["reasonCode"], `${path}.reasonCode`);
    if (incidentId === undefined || reasonCode === undefined) return undefined;
    const severity = incident["severity"];
    if (severity !== "LOG" && severity !== "NOTIFY" && severity !== "PAGE") {
      return ctx.fail(`${path}.severity`, `must be one of ${INCIDENT_SEVERITIES.join(", ")} (§14.4)`);
    }
    let feedId: string | undefined;
    if (incident["feedId"] !== undefined) {
      feedId = requireCode(ctx, incident["feedId"], `${path}.feedId`);
      if (feedId === undefined) return undefined;
    }
    if (seen.has(incidentId)) {
      return ctx.fail(`${path}.incidentId`, "duplicate incidentId; the active set is ambiguous");
    }
    seen.add(incidentId);
    incidents.push({ incidentId, reasonCode, severity, ...(feedId === undefined ? {} : { feedId }) });
  }
  return { activeIncidents: incidents };
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = [
  "subject",
  "asOf",
  "trigger",
  "config",
  "book",
  "trades",
  "reference",
  "lifecycle",
  "quality",
] as const;

/**
 * Validates the materialized input tree against the v1 contract. Pure; reads
 * only the tree it is given; reports refusal paths, and never throws ON ITS
 * PRECONDITION — a MATERIALIZED tree (own data, no accessors, no prototype
 * chain), which is what `materializeInput` produces and what the composed
 * entry `computeFeatureSnapshot` hands it, inside that entry's own
 * `try`/`catch` (`snapshot.ts`, `computeGuarded` step 1 then 2). On a raw
 * caller object the claim is false: a throwing enumerable getter escapes this
 * function as an exception (`WP-160` review finding R1-L2, measured). The
 * composed entry is the total surface; this export is a helper below the
 * line `GOV-2A` drew on 2026-09-04 (`docs/handoffs/GOV-2A.md`, the `WP-190`
 * R1-L1 ruling: totality claims scope to COMPOSED entries, and a helper may
 * throw on precondition violation provided its claim text says so).
 *
 * Corrected 2026-09-15 by `GOV-2C` (comment only). The superseded text read:
 * "Pure; reads only the tree it is given; reports refusal paths, never
 * throws." It was written by `WP-160`, and the ruling required it corrected
 * "by the next bounded round touching each package" — `WP-160-FU1` (merged
 * `5faf16b`, 2026-09-06) touched this package and left it, because nothing
 * checks the ruling; this is the correction, not a guard, so a direct caller
 * still owns materializing first.
 */
export function validateFeatureInput(tree: unknown): InputValidation {
  const ctx = new Ctx();

  const root = requireRecord(ctx, tree, "input", [...TOP_LEVEL_KEYS]);
  if (root === undefined) {
    return { ok: false, kind: ctx.kind, problems: ctx.problems };
  }

  const asOf = requireTimestamp(ctx, root["asOf"], "input.asOf");
  const subject = validateSubject(ctx, root["subject"]);
  const trigger = validateTrigger(ctx, root["trigger"]);
  const config = validateConfig(ctx, root["config"]);
  const quality = validateQuality(ctx, root["quality"]);
  if (asOf === undefined || subject === undefined || trigger === undefined || config === undefined || quality === undefined) {
    return { ok: false, kind: ctx.kind, problems: ctx.problems };
  }

  // ---- book ---------------------------------------------------------------
  const bookRecord = requireRecord(ctx, root["book"], "input.book", ["serializedBook", "lastEventAt"]);
  if (bookRecord === undefined) {
    return { ok: false, kind: ctx.kind, problems: ctx.problems };
  }
  const serializedBook = requireString(ctx, bookRecord["serializedBook"], "input.book.serializedBook", MAX_SERIALIZED_BOOK_LENGTH);
  const bookLastEventAt = requireTimestamp(ctx, bookRecord["lastEventAt"], "input.book.lastEventAt");
  if (serializedBook === undefined || bookLastEventAt === undefined) {
    return { ok: false, kind: ctx.kind, problems: ctx.problems };
  }
  const bookRead = readBookSerialization(serializedBook);
  if (!bookRead.ok) {
    const kind =
      bookRead.kind === "UNSUPPORTED_VERSION"
        ? "BOOK_UNSUPPORTED"
        : bookRead.kind === "MALFORMED"
          ? "BOOK_MALFORMED"
          : bookRead.kind === "INCONSISTENT"
            ? "BOOK_INCONSISTENT"
            : "BOOK_NOT_BASELINED";
    return { ok: false, kind, problems: [{ path: "input.book.serializedBook", problem: bookRead.problem }] };
  }
  if (bookRead.book.internalMarketId !== subject.internalMarketId || bookRead.book.tokenId !== subject.tokenId) {
    return {
      ok: false,
      kind: "SUBJECT_MISMATCH",
      problems: [
        {
          path: "input.book.serializedBook",
          problem: `the serialized book names (${bookRead.book.internalMarketId}, ${bookRead.book.tokenId}) but the subject is (${subject.internalMarketId}, ${subject.tokenId}); books are independent per outcome token and are never mixed (§9.4)`,
        },
      ],
    };
  }

  // ---- optional sections --------------------------------------------------
  let trades: ValidatedTradesInput | undefined;
  if (root["trades"] !== undefined) {
    trades = validateTrades(ctx, root["trades"], asOf.epochMs);
    if (trades === undefined) {
      return { ok: false, kind: ctx.kind, problems: ctx.problems };
    }
  }
  const reference = validateReference(ctx, root["reference"], asOf.epochMs);
  if (reference === undefined) {
    return { ok: false, kind: ctx.kind, problems: ctx.problems };
  }
  let lifecycle: ValidatedLifecycleInput | undefined;
  if (root["lifecycle"] !== undefined) {
    lifecycle = validateLifecycle(ctx, root["lifecycle"]);
    if (lifecycle === undefined) {
      return { ok: false, kind: ctx.kind, problems: ctx.problems };
    }
  }

  if (ctx.problems.length > 0) {
    return { ok: false, kind: ctx.kind, problems: ctx.problems };
  }

  // The validated model is returned as a PROTOTYPE-FREE deep copy: its
  // optional sections/fields express absence as an absent key, and an
  // ordinary literal would let a polluted `Object.prototype` answer for an
  // absent one (see `ownPlainCopy` — this package's hostile battery
  // reproduced exactly that against an earlier ordinary-literal draft).
  const model: ValidatedFeatureInput = {
    subject,
    asOf: asOf.iso,
    asOfEpochMs: asOf.epochMs,
    trigger,
    config,
    book: {
      serializedBook,
      lastEventAt: bookLastEventAt.iso,
      lastEventAtEpochMs: bookLastEventAt.epochMs,
      parsed: bookRead.book,
    },
    ...(trades === undefined ? {} : { trades }),
    reference,
    ...(lifecycle === undefined ? {} : { lifecycle }),
    quality,
  };
  return { ok: true, input: ownPlainCopy(model) as ValidatedFeatureInput };
}
