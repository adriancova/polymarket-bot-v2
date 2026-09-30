/**
 * The Static Bracket parameter schema — handoff §13.2, modeled faithfully.
 *
 * REQUIRED VERSUS DEFAULTED, the rule this package applies and states:
 *
 *   **Every field is required. There are no defaults, and no key is optional.**
 *
 * A configuration is accepted only if it states every key of the grammar below;
 * a missing key is a refusal that names the path. Optional BEHAVIOUR is
 * expressed as an explicit switch inside an always-present object (`exit.stop`
 * carries `enabled: false` rather than being absent), never as an absent key.
 *
 * Three reasons, in order of weight:
 *
 * 1. Safety. Several of these settings decide whether the strategy enters near
 *    a close, how far it may lose, and whether it holds to resolution. ADR-020's
 *    lesson is that a safety-relevant value must never rest on something the
 *    operator did not write down; §13.2's example is an EXAMPLE, and adopting
 *    its numbers as defaults would make an unstated config silently trade at
 *    someone else's risk limits.
 * 2. Precedent. `docs/contracts/features-v1.md` §3 states the same rule for the
 *    feature engine's config ("NO DEFAULTS EXIST; every field is explicit").
 * 3. Pollution. A validated params tree with no absent key is a tree in which
 *    every read is an own-property read, so nothing a callback reads out of
 *    `ctx.params()` can be answered by a polluted `Object.prototype` — see
 *    `plain.ts` for why that matters given the runtime's own copy.
 *
 * THE WIRE FORM IS §13.2's, AND SO IS THE PARSED FORM. The value handed to
 * `safeParse` uses §13.2's snake_case keys exactly (`trigger_price_lte`,
 * `maximum_total_cost`, `convert_to_aggressive_after_ms`, ...), so a YAML file
 * written against the handoff is the input — and the validated value this
 * module emits carries the SAME keys, now total, frozen and prototype-free.
 *
 * Key-identity is a decision with two consequences worth stating:
 *
 * - **Validation is IDEMPOTENT.** `safeParse(safeParse(x).data).data` equals
 *   `safeParse(x).data`. That is not decoration: the runtime validates the raw
 *   params once at creation and thereafter `ctx.params()` answers with its own
 *   materialized COPY of the parsed value, so every callback re-validates an
 *   already-parsed tree. A renaming parse would make that second pass fail and
 *   the strategy refuse every evaluation; with key-identity the second pass is
 *   a cheap, total re-check of a fixed-size tree of scalars.
 * - **A reason code, a refusal path and a review all name the key the operator
 *   wrote**, with no mapping table between the config text and the code.
 *
 * FIELDS BEYOND §13.2 — disclosed, with a basis, and never a redefinition of a
 * §13.2 field:
 *
 * | Added field | Why it exists |
 * | --- | --- |
 * | `entry.trigger_feature_key`, `exit.stop.trigger_feature_key` | §13.2 names a `trigger_basis`; the value must be read from a real WP-160 feature id at a key the composition root projects. See `features.ts`. |
 * | `entry.economic_leg_policy` | §13.4 requires a YES/NO economic-leg comparison "with and without inventory"; §9.10 makes leg selection respect actual available inventory. Whether to consider the complementary leg at all is a policy, so it is stated. |
 * | `entry.economics.*` (entry/exit fee per share, minimum expected net edge) | §13.4 requires "fee-aware rejection when expected edge is insufficient" and §9.8 check 12 requires edge to survive fees; §13.2 carries no fee field, and this package refuses to invent a venue fee schedule. The operator supplies the estimate that the strategy is held to. |
 * | `entry.execution.submission_unknown_after_ms` | §13.4 requires "entry response lost and later reconciled"; the strategy must be able to say when silence has lasted long enough to be treated as UNKNOWN — and §6 invariant 6 says unknown is never rejection. |
 * | `entry.execution.order_validity_ms` | §7.7 makes `validUntil` a required field of every position intent. |
 * | `exit.stop.enabled` | The stop is optional behaviour; an optional behaviour is an explicit switch, never an absent key. |
 * | `data_quality.*` | §13.3's rule that a stop on stale data is forbidden and §9.9's incident ladder need a stated staleness bound and a stated policy. |
 * | `data_quality.book_age_feature_key` (grammar version 2 only) | ADR-023: the book age is read from the composition root's measurement (`quality.input_feed_ages@polymarket.book`), which may vouch for a quiet book on a live delivery session; version 1 keeps `now - book.asOf`. |
 *
 * Purity: this module reads no clock, draws no randomness, performs no I/O, and
 * imports no schema library (`packages/strategies/**` is purity-restricted).
 * Validation is hand-rolled and total.
 */

import {
  BASIS_FEATURE_ID,
  INCIDENT_FEATURE_ID,
  TRIGGER_BASES,
  parseFeatureKey,
  type TriggerBasis,
} from "./features.js";
import {
  lessOrEqual,
  readConfigDecimal,
  type Money,
  type Price,
  type Shares,
} from "./economics.js";
import {
  bad,
  describe,
  isPlainRecord,
  ok,
  plainCopy,
  readOwn,
  refuseUnknownKeys,
  type Outcome,
  type PlainJson,
  type PlainRecord,
} from "./plain.js";

/**
 * The configuration grammar's own version, carried in the config (§13.2
 * `version`): the ORIGINAL grammar, version 1.
 */
export const STATIC_BRACKET_CONFIG_VERSION = 1;

/**
 * `THROUGHPUT-1c` (ADR-023 §6): grammar version 2. It is version 1 plus ONE
 * required key, `data_quality.book_age_feature_key`, and nothing else; a
 * version-1 document loads exactly as it always did and means exactly what it
 * always meant (the book age is `now - book.asOf`). The key is REFUSED in a
 * version-1 document (unknown key) and REQUIRED in a version-2 one, so the
 * version alone says which rule a configuration's staleness gate follows.
 */
export const STATIC_BRACKET_CONFIG_VERSION_2 = 2;

/** Every grammar version this build implements, oldest first. */
export const STATIC_BRACKET_CONFIG_VERSIONS: readonly number[] = Object.freeze([
  STATIC_BRACKET_CONFIG_VERSION,
  STATIC_BRACKET_CONFIG_VERSION_2,
]);
export const STATIC_BRACKET_STRATEGY_NAME = "static-bracket";

export const OUTCOME_SIDES = Object.freeze(["YES", "NO"] as const);
export type OutcomeSide = (typeof OUTCOME_SIDES)[number];

export const LIQUIDITY_PREFERENCES = Object.freeze([
  "MAKER_ONLY",
  "MAKER_PREFERRED",
  "TAKER_OK",
  "TAKER_ONLY",
] as const);
export type LiquidityPreference = (typeof LIQUIDITY_PREFERENCES)[number];

export const PARTIAL_FILL_POLICIES = Object.freeze([
  "REJECT",
  "ACCEPT_ANY",
  "ACCEPT_MINIMUM",
] as const);
export type PartialFillPolicy = (typeof PARTIAL_FILL_POLICIES)[number];

/**
 * Venue order types, restricted to the four the venue report records
 * (`docs/venue/verified-2026-08-24.md` §2.3: GTC, GTD, FAK, FOK). This package
 * asserts nothing further about them: it never places an order, and the value
 * travels to the execution planner as configuration and as an intent tag.
 */
export const IMMEDIATE_ORDER_TYPES = Object.freeze(["FAK", "FOK", "GTC", "GTD"] as const);
export type ImmediateOrderType = (typeof IMMEDIATE_ORDER_TYPES)[number];

export const REDUCTION_URGENCIES = Object.freeze(["NORMAL", "AGGRESSIVE", "IMMEDIATE"] as const);
export type ReductionUrgency = (typeof REDUCTION_URGENCIES)[number];

export const ECONOMIC_LEG_POLICIES = Object.freeze([
  "DIRECT_ONLY",
  "PREFER_CHEAPEST_WITH_INVENTORY",
] as const);
export type EconomicLegPolicy = (typeof ECONOMIC_LEG_POLICIES)[number];

/**
 * End-of-market behaviour (§13.3 rule 5: "End-of-market behavior is an explicit
 * configured policy"). The three values name §9.9 ladder actions:
 * `PROTECTED_REDUCE` reduces the position under a price floor,
 * `HOLD_TO_RESOLUTION` deliberately carries it into settlement, and
 * `CANCEL_ONLY` withdraws resting orders and takes no position action.
 */
export const FINAL_POLICIES = Object.freeze([
  "PROTECTED_REDUCE",
  "HOLD_TO_RESOLUTION",
  "CANCEL_ONLY",
] as const);
export type FinalPolicy = (typeof FINAL_POLICIES)[number];

/**
 * The only conforming data-quality response. §9.9's ladder for a stale
 * Polymarket book is "cancel resting orders; no blind aggressive orders", and
 * §13.3 forbids a stop on stale data outright, so a value that could switch the
 * cancel off would be a safety weakening rather than a configuration choice.
 * The key is nevertheless stated in the config so the operator affirms it and
 * so widening the vocabulary is a visible grammar change.
 */
export const DATA_QUALITY_RESPONSES = Object.freeze(["PAUSE_AND_CANCEL"] as const);
export type DataQualityResponse = (typeof DATA_QUALITY_RESPONSES)[number];

export interface EntryExecutionParams {
  readonly liquidity_preference: LiquidityPreference;
  readonly passive_price: Price;
  readonly convert_to_aggressive_after_ms: number;
  readonly maximum_buy_price: Price;
  readonly immediate_order_type: ImmediateOrderType;
  readonly partial_fill_policy: PartialFillPolicy;
  readonly minimum_fill_shares: Shares;
  readonly submission_unknown_after_ms: number;
  readonly order_validity_ms: number;
}

export interface EntryEconomicsParams {
  readonly entry_fee_per_share: Money;
  readonly exit_fee_per_share: Money;
  readonly minimum_expected_net_edge: Money;
}

export interface EntryParams {
  readonly trigger_basis: TriggerBasis;
  readonly trigger_feature_key: string;
  readonly trigger_price_lte: Price;
  readonly size_shares: Shares;
  readonly maximum_total_cost: Money;
  readonly economic_leg_policy: EconomicLegPolicy;
  readonly execution: EntryExecutionParams;
  readonly economics: EntryEconomicsParams;
}

export interface TakeProfitParams {
  readonly price: Price;
  readonly liquidity_preference: LiquidityPreference;
  readonly post_only: boolean;
}

export interface StopParams {
  readonly enabled: boolean;
  readonly trigger_basis: TriggerBasis;
  readonly trigger_feature_key: string;
  readonly trigger_price_lte: Price;
  readonly minimum_sell_price: Price;
  readonly urgency: ReductionUrgency;
}

export interface ExitParams {
  readonly take_profit: TakeProfitParams;
  readonly stop: StopParams;
  readonly maximum_holding_seconds: number;
  readonly entry_cutoff_before_close_seconds: number;
  readonly exit_cutoff_before_close_seconds: number;
  readonly final_policy: FinalPolicy;
  readonly allow_resolution_hold: boolean;
}

export interface ReentryParams {
  readonly maximum_entries_per_market: number;
  readonly cooldown_seconds: number;
}

export interface RiskParams {
  readonly maximum_position_shares: Shares;
  readonly maximum_contractual_loss: Money;
  readonly maximum_slippage: Money;
  readonly maximum_book_participation: Price;
}

export interface DataQualityParams {
  readonly maximum_book_age_ms: number;
  /**
   * Grammar version 2 only (ADR-023 §6), and present IFF `version` is 2: the
   * feature key the book age of the configured direction's book is read from
   * — `quality.input_feed_ages@polymarket.book`, the age the composition root
   * measured under its book-freshness basis. Absent (never `null`) in a
   * version-1 tree, so validation stays idempotent: a version-1 tree carries
   * no key its own grammar refuses.
   */
  readonly book_age_feature_key?: string;
  readonly incident_feature_key: string;
  readonly on_stale_book: DataQualityResponse;
  readonly on_incident: DataQualityResponse;
}

export interface MarketSelectorParams {
  readonly series_id: string;
  readonly direction: OutcomeSide;
}

/** The validated, total, frozen, prototype-free configuration. */
export interface StaticBracketParams {
  readonly strategy: typeof STATIC_BRACKET_STRATEGY_NAME;
  readonly version: number;
  readonly market_selector: MarketSelectorParams;
  readonly entry: EntryParams;
  readonly exit: ExitParams;
  readonly reentry: ReentryParams;
  readonly risk: RiskParams;
  readonly data_quality: DataQualityParams;
}

const MAX_DURATION_MS = 86_400_000;
const MAX_DURATION_SECONDS = 86_400;
const MAX_ENTRIES = 1_000;
const SERIES_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;

function readRecord(parent: PlainRecord, key: string, path: string): Outcome<PlainRecord> {
  const value = readOwn(parent, key, path);
  if (!value.ok) return value;
  if (!isPlainRecord(value.value)) {
    return bad(`${path}.${key} must be an object; received ${describe(value.value)}`);
  }
  return ok(value.value);
}

function readEnum<T extends string>(
  parent: PlainRecord,
  key: string,
  path: string,
  allowed: readonly T[],
): Outcome<T> {
  const value = readOwn(parent, key, path);
  if (!value.ok) return value;
  if (typeof value.value !== "string" || !(allowed as readonly string[]).includes(value.value)) {
    return bad(
      `${path}.${key} must be one of ${allowed.join(", ")}; received ` +
        (typeof value.value === "string" ? JSON.stringify(value.value) : describe(value.value)),
    );
  }
  return ok(value.value as T);
}

function readBoolean(parent: PlainRecord, key: string, path: string): Outcome<boolean> {
  const value = readOwn(parent, key, path);
  if (!value.ok) return value;
  if (typeof value.value !== "boolean") {
    return bad(`${path}.${key} must be a boolean; received ${describe(value.value)}`);
  }
  return ok(value.value);
}

function readInteger(
  parent: PlainRecord,
  key: string,
  path: string,
  minimum: number,
  maximum: number,
): Outcome<number> {
  const value = readOwn(parent, key, path);
  if (!value.ok) return value;
  const numeric = value.value;
  if (typeof numeric !== "number" || !Number.isSafeInteger(numeric)) {
    return bad(
      `${path}.${key} must be an integer (a duration or a count is not an economic value); ` +
        `received ${describe(numeric)}`,
    );
  }
  if (numeric < minimum || numeric > maximum) {
    return bad(
      `${path}.${key} must be between ${String(minimum)} and ${String(maximum)}; received ` +
        String(numeric),
    );
  }
  return ok(numeric);
}

// Configuration decimals go through the one normalizing door
// (`readConfigDecimal`): canonical plus the §7.3-sanctioned redundant zeros,
// stored canonically. §13.2's own `price: "0.50"` is why that door exists.
function readPriceField(parent: PlainRecord, key: string, path: string): Outcome<Price> {
  const value = readOwn(parent, key, path);
  if (!value.ok) return value;
  return readConfigDecimal(value.value, `${path}.${key}`, "UNIT_INTERVAL");
}

function readPositiveField(parent: PlainRecord, key: string, path: string): Outcome<string> {
  const value = readOwn(parent, key, path);
  if (!value.ok) return value;
  return readConfigDecimal(value.value, `${path}.${key}`, "POSITIVE");
}

function readNonNegativeField(parent: PlainRecord, key: string, path: string): Outcome<string> {
  const value = readOwn(parent, key, path);
  if (!value.ok) return value;
  return readConfigDecimal(value.value, `${path}.${key}`, "NON_NEGATIVE");
}

function readFeatureKeyField(
  parent: PlainRecord,
  key: string,
  path: string,
  expectedFeatureId: string | null,
): Outcome<string> {
  const value = readOwn(parent, key, path);
  if (!value.ok) return value;
  const parsed = parseFeatureKey(value.value, `${path}.${key}`, expectedFeatureId);
  return parsed.ok ? ok(parsed.value.key) : parsed;
}

const TOP_LEVEL_KEYS = [
  "strategy",
  "version",
  "market_selector",
  "entry",
  "exit",
  "reentry",
  "risk",
  "data_quality",
];
const MARKET_SELECTOR_KEYS = ["series_id", "direction"];
const ENTRY_KEYS = [
  "trigger_basis",
  "trigger_feature_key",
  "trigger_price_lte",
  "size_shares",
  "maximum_total_cost",
  "economic_leg_policy",
  "execution",
  "economics",
];
const EXECUTION_KEYS = [
  "liquidity_preference",
  "passive_price",
  "convert_to_aggressive_after_ms",
  "maximum_buy_price",
  "immediate_order_type",
  "partial_fill_policy",
  "minimum_fill_shares",
  "submission_unknown_after_ms",
  "order_validity_ms",
];
const ECONOMICS_KEYS = ["entry_fee_per_share", "exit_fee_per_share", "minimum_expected_net_edge"];
const EXIT_KEYS = [
  "take_profit",
  "stop",
  "maximum_holding_seconds",
  "entry_cutoff_before_close_seconds",
  "exit_cutoff_before_close_seconds",
  "final_policy",
  "allow_resolution_hold",
];
const TAKE_PROFIT_KEYS = ["price", "liquidity_preference", "post_only"];
const STOP_KEYS = [
  "enabled",
  "trigger_basis",
  "trigger_feature_key",
  "trigger_price_lte",
  "minimum_sell_price",
  "urgency",
];
const REENTRY_KEYS = ["maximum_entries_per_market", "cooldown_seconds"];
const RISK_KEYS = [
  "maximum_position_shares",
  "maximum_contractual_loss",
  "maximum_slippage",
  "maximum_book_participation",
];
const DATA_QUALITY_KEYS = [
  "maximum_book_age_ms",
  "incident_feature_key",
  "on_stale_book",
  "on_incident",
];
/** Grammar version 2's `data_quality` keys: version 1's plus one (ADR-023 §6). */
const DATA_QUALITY_KEYS_V2 = [...DATA_QUALITY_KEYS, "book_age_feature_key"];

/**
 * Validates a §13.2 configuration. TOTAL: never throws, and every refusal names
 * a path. The value is materialized prototype-free FIRST (`plain.ts` D1), and
 * every read below is of that copy (D3).
 */
export function validateStaticBracketParams(input: unknown): Outcome<StaticBracketParams> {
  const materialized = plainCopy(input, "params");
  if (!materialized.ok) return materialized;
  const root: PlainJson = materialized.value;
  if (!isPlainRecord(root)) {
    return bad(`params must be an object; received ${describe(root)}`);
  }
  const unknownTop = refuseUnknownKeys(root, TOP_LEVEL_KEYS, "params");
  if (!unknownTop.ok) return unknownTop;

  const strategy = readOwn(root, "strategy", "params");
  if (!strategy.ok) return strategy;
  if (strategy.value !== STATIC_BRACKET_STRATEGY_NAME) {
    return bad(
      `params.strategy must be "${STATIC_BRACKET_STRATEGY_NAME}"; a configuration for another ` +
        "strategy is refused rather than reinterpreted",
    );
  }
  const version = readInteger(root, "version", "params", 1, 1_000_000);
  if (!version.ok) return version;
  if (!STATIC_BRACKET_CONFIG_VERSIONS.includes(version.value)) {
    return bad(
      `params.version must be one of ${STATIC_BRACKET_CONFIG_VERSIONS.map(String).join(", ")}; ` +
        "this build implements exactly these configuration grammar versions and refuses any " +
        "other rather than guessing which fields moved",
    );
  }

  const marketSelector = parseMarketSelector(root);
  if (!marketSelector.ok) return marketSelector;
  const entry = parseEntry(root);
  if (!entry.ok) return entry;
  const exit = parseExit(root);
  if (!exit.ok) return exit;
  const reentry = parseReentry(root);
  if (!reentry.ok) return reentry;
  const risk = parseRisk(root);
  if (!risk.ok) return risk;
  const dataQuality = parseDataQuality(root, version.value);
  if (!dataQuality.ok) return dataQuality;

  const params: StaticBracketParams = Object.freeze(
    Object.assign(Object.create(null) as object, {
      strategy: STATIC_BRACKET_STRATEGY_NAME,
      version: version.value,
      market_selector: marketSelector.value,
      entry: entry.value,
      exit: exit.value,
      reentry: reentry.value,
      risk: risk.value,
      data_quality: dataQuality.value,
    }),
  ) as StaticBracketParams;

  const coherent = checkCoherence(params);
  if (!coherent.ok) return coherent;
  return ok(params);
}

function parseMarketSelector(root: PlainRecord): Outcome<MarketSelectorParams> {
  const record = readRecord(root, "market_selector", "params");
  if (!record.ok) return record;
  const unknown = refuseUnknownKeys(record.value, MARKET_SELECTOR_KEYS, "params.market_selector");
  if (!unknown.ok) return unknown;
  const seriesId = readOwn(record.value, "series_id", "params.market_selector");
  if (!seriesId.ok) return seriesId;
  if (typeof seriesId.value !== "string" || !SERIES_ID_PATTERN.test(seriesId.value)) {
    return bad(
      "params.market_selector.series_id must be a bounded series identifier matching " +
        `${SERIES_ID_PATTERN.source}; the series is bound BY CONFIGURED ID and this package ` +
        "asserts nothing about its settlement rules",
    );
  }
  const direction = readEnum(record.value, "direction", "params.market_selector", OUTCOME_SIDES);
  if (!direction.ok) return direction;
  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        series_id: seriesId.value,
        direction: direction.value,
      }),
    ) as MarketSelectorParams,
  );
}

function parseEntry(root: PlainRecord): Outcome<EntryParams> {
  const record = readRecord(root, "entry", "params");
  if (!record.ok) return record;
  const unknown = refuseUnknownKeys(record.value, ENTRY_KEYS, "params.entry");
  if (!unknown.ok) return unknown;

  const triggerBasis = readEnum(record.value, "trigger_basis", "params.entry", TRIGGER_BASES);
  if (!triggerBasis.ok) return triggerBasis;
  const triggerFeatureKey = readFeatureKeyField(
    record.value,
    "trigger_feature_key",
    "params.entry",
    BASIS_FEATURE_ID[triggerBasis.value],
  );
  if (!triggerFeatureKey.ok) return triggerFeatureKey;
  const triggerPriceLte = readPriceField(record.value, "trigger_price_lte", "params.entry");
  if (!triggerPriceLte.ok) return triggerPriceLte;
  const sizeShares = readPositiveField(record.value, "size_shares", "params.entry");
  if (!sizeShares.ok) return sizeShares;
  const maximumTotalCost = readNonNegativeField(record.value, "maximum_total_cost", "params.entry");
  if (!maximumTotalCost.ok) return maximumTotalCost;
  const economicLegPolicy = readEnum(
    record.value,
    "economic_leg_policy",
    "params.entry",
    ECONOMIC_LEG_POLICIES,
  );
  if (!economicLegPolicy.ok) return economicLegPolicy;

  const execution = parseExecution(record.value);
  if (!execution.ok) return execution;
  const economics = parseEconomics(record.value);
  if (!economics.ok) return economics;

  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        trigger_basis: triggerBasis.value,
        trigger_feature_key: triggerFeatureKey.value,
        trigger_price_lte: triggerPriceLte.value,
        size_shares: sizeShares.value,
        maximum_total_cost: maximumTotalCost.value,
        economic_leg_policy: economicLegPolicy.value,
        execution: execution.value,
        economics: economics.value,
      }),
    ) as EntryParams,
  );
}

function parseExecution(entry: PlainRecord): Outcome<EntryExecutionParams> {
  const record = readRecord(entry, "execution", "params.entry");
  if (!record.ok) return record;
  const path = "params.entry.execution";
  const unknown = refuseUnknownKeys(record.value, EXECUTION_KEYS, path);
  if (!unknown.ok) return unknown;

  const liquidityPreference = readEnum(
    record.value,
    "liquidity_preference",
    path,
    LIQUIDITY_PREFERENCES,
  );
  if (!liquidityPreference.ok) return liquidityPreference;
  const passivePrice = readPriceField(record.value, "passive_price", path);
  if (!passivePrice.ok) return passivePrice;
  const convertToAggressiveAfterMs = readInteger(
    record.value,
    "convert_to_aggressive_after_ms",
    path,
    0,
    MAX_DURATION_MS,
  );
  if (!convertToAggressiveAfterMs.ok) return convertToAggressiveAfterMs;
  const maximumBuyPrice = readPriceField(record.value, "maximum_buy_price", path);
  if (!maximumBuyPrice.ok) return maximumBuyPrice;
  const immediateOrderType = readEnum(
    record.value,
    "immediate_order_type",
    path,
    IMMEDIATE_ORDER_TYPES,
  );
  if (!immediateOrderType.ok) return immediateOrderType;
  const partialFillPolicy = readEnum(record.value, "partial_fill_policy", path, PARTIAL_FILL_POLICIES);
  if (!partialFillPolicy.ok) return partialFillPolicy;
  const minimumFillShares = readNonNegativeField(record.value, "minimum_fill_shares", path);
  if (!minimumFillShares.ok) return minimumFillShares;
  const submissionUnknownAfterMs = readInteger(
    record.value,
    "submission_unknown_after_ms",
    path,
    1,
    MAX_DURATION_MS,
  );
  if (!submissionUnknownAfterMs.ok) return submissionUnknownAfterMs;
  const orderValidityMs = readInteger(record.value, "order_validity_ms", path, 1, MAX_DURATION_MS);
  if (!orderValidityMs.ok) return orderValidityMs;

  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        liquidity_preference: liquidityPreference.value,
        passive_price: passivePrice.value,
        convert_to_aggressive_after_ms: convertToAggressiveAfterMs.value,
        maximum_buy_price: maximumBuyPrice.value,
        immediate_order_type: immediateOrderType.value,
        partial_fill_policy: partialFillPolicy.value,
        minimum_fill_shares: minimumFillShares.value,
        submission_unknown_after_ms: submissionUnknownAfterMs.value,
        order_validity_ms: orderValidityMs.value,
      }),
    ) as EntryExecutionParams,
  );
}

function parseEconomics(entry: PlainRecord): Outcome<EntryEconomicsParams> {
  const record = readRecord(entry, "economics", "params.entry");
  if (!record.ok) return record;
  const path = "params.entry.economics";
  const unknown = refuseUnknownKeys(record.value, ECONOMICS_KEYS, path);
  if (!unknown.ok) return unknown;
  const entryFeePerShare = readNonNegativeField(record.value, "entry_fee_per_share", path);
  if (!entryFeePerShare.ok) return entryFeePerShare;
  const exitFeePerShare = readNonNegativeField(record.value, "exit_fee_per_share", path);
  if (!exitFeePerShare.ok) return exitFeePerShare;
  const minimumExpectedNetEdge = readNonNegativeField(record.value, "minimum_expected_net_edge", path);
  if (!minimumExpectedNetEdge.ok) return minimumExpectedNetEdge;
  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        entry_fee_per_share: entryFeePerShare.value,
        exit_fee_per_share: exitFeePerShare.value,
        minimum_expected_net_edge: minimumExpectedNetEdge.value,
      }),
    ) as EntryEconomicsParams,
  );
}

function parseExit(root: PlainRecord): Outcome<ExitParams> {
  const record = readRecord(root, "exit", "params");
  if (!record.ok) return record;
  const unknown = refuseUnknownKeys(record.value, EXIT_KEYS, "params.exit");
  if (!unknown.ok) return unknown;

  const takeProfit = parseTakeProfit(record.value);
  if (!takeProfit.ok) return takeProfit;
  const stop = parseStop(record.value);
  if (!stop.ok) return stop;
  const maximumHoldingSeconds = readInteger(
    record.value,
    "maximum_holding_seconds",
    "params.exit",
    1,
    MAX_DURATION_SECONDS,
  );
  if (!maximumHoldingSeconds.ok) return maximumHoldingSeconds;
  const entryCutoff = readInteger(
    record.value,
    "entry_cutoff_before_close_seconds",
    "params.exit",
    0,
    MAX_DURATION_SECONDS,
  );
  if (!entryCutoff.ok) return entryCutoff;
  const exitCutoff = readInteger(
    record.value,
    "exit_cutoff_before_close_seconds",
    "params.exit",
    0,
    MAX_DURATION_SECONDS,
  );
  if (!exitCutoff.ok) return exitCutoff;
  const finalPolicy = readEnum(record.value, "final_policy", "params.exit", FINAL_POLICIES);
  if (!finalPolicy.ok) return finalPolicy;
  const allowResolutionHold = readBoolean(record.value, "allow_resolution_hold", "params.exit");
  if (!allowResolutionHold.ok) return allowResolutionHold;

  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        take_profit: takeProfit.value,
        stop: stop.value,
        maximum_holding_seconds: maximumHoldingSeconds.value,
        entry_cutoff_before_close_seconds: entryCutoff.value,
        exit_cutoff_before_close_seconds: exitCutoff.value,
        final_policy: finalPolicy.value,
        allow_resolution_hold: allowResolutionHold.value,
      }),
    ) as ExitParams,
  );
}

function parseTakeProfit(exit: PlainRecord): Outcome<TakeProfitParams> {
  const record = readRecord(exit, "take_profit", "params.exit");
  if (!record.ok) return record;
  const path = "params.exit.take_profit";
  const unknown = refuseUnknownKeys(record.value, TAKE_PROFIT_KEYS, path);
  if (!unknown.ok) return unknown;
  const price = readPriceField(record.value, "price", path);
  if (!price.ok) return price;
  const liquidityPreference = readEnum(
    record.value,
    "liquidity_preference",
    path,
    LIQUIDITY_PREFERENCES,
  );
  if (!liquidityPreference.ok) return liquidityPreference;
  const postOnly = readBoolean(record.value, "post_only", path);
  if (!postOnly.ok) return postOnly;
  if (postOnly.value && liquidityPreference.value !== "MAKER_ONLY") {
    return bad(
      `${path}: post_only is true but liquidity_preference is ${liquidityPreference.value}; ` +
        "post-only applies only to resting limit orders (venue report §2.3), so the two must " +
        "agree rather than being reconciled silently",
    );
  }
  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        price: price.value,
        liquidity_preference: liquidityPreference.value,
        post_only: postOnly.value,
      }),
    ) as TakeProfitParams,
  );
}

function parseStop(exit: PlainRecord): Outcome<StopParams> {
  const record = readRecord(exit, "stop", "params.exit");
  if (!record.ok) return record;
  const path = "params.exit.stop";
  const unknown = refuseUnknownKeys(record.value, STOP_KEYS, path);
  if (!unknown.ok) return unknown;
  const enabled = readBoolean(record.value, "enabled", path);
  if (!enabled.ok) return enabled;
  const triggerBasis = readEnum(record.value, "trigger_basis", path, TRIGGER_BASES);
  if (!triggerBasis.ok) return triggerBasis;
  const triggerFeatureKey = readFeatureKeyField(
    record.value,
    "trigger_feature_key",
    path,
    BASIS_FEATURE_ID[triggerBasis.value],
  );
  if (!triggerFeatureKey.ok) return triggerFeatureKey;
  const triggerPriceLte = readPriceField(record.value, "trigger_price_lte", path);
  if (!triggerPriceLte.ok) return triggerPriceLte;
  const minimumSellPrice = readPriceField(record.value, "minimum_sell_price", path);
  if (!minimumSellPrice.ok) return minimumSellPrice;
  const urgency = readEnum(record.value, "urgency", path, REDUCTION_URGENCIES);
  if (!urgency.ok) return urgency;
  const ordered = lessOrEqual(minimumSellPrice.value, triggerPriceLte.value, path);
  if (!ordered.ok) return ordered;
  if (!ordered.value) {
    return bad(
      `${path}: minimum_sell_price ${minimumSellPrice.value} is above trigger_price_lte ` +
        `${triggerPriceLte.value}, so the stop could never fill at its own floor`,
    );
  }
  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        enabled: enabled.value,
        trigger_basis: triggerBasis.value,
        trigger_feature_key: triggerFeatureKey.value,
        trigger_price_lte: triggerPriceLte.value,
        minimum_sell_price: minimumSellPrice.value,
        urgency: urgency.value,
      }),
    ) as StopParams,
  );
}

function parseReentry(root: PlainRecord): Outcome<ReentryParams> {
  const record = readRecord(root, "reentry", "params");
  if (!record.ok) return record;
  const unknown = refuseUnknownKeys(record.value, REENTRY_KEYS, "params.reentry");
  if (!unknown.ok) return unknown;
  const maximumEntriesPerMarket = readInteger(
    record.value,
    "maximum_entries_per_market",
    "params.reentry",
    1,
    MAX_ENTRIES,
  );
  if (!maximumEntriesPerMarket.ok) return maximumEntriesPerMarket;
  const cooldownSeconds = readInteger(
    record.value,
    "cooldown_seconds",
    "params.reentry",
    0,
    MAX_DURATION_SECONDS,
  );
  if (!cooldownSeconds.ok) return cooldownSeconds;
  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        maximum_entries_per_market: maximumEntriesPerMarket.value,
        cooldown_seconds: cooldownSeconds.value,
      }),
    ) as ReentryParams,
  );
}

function parseRisk(root: PlainRecord): Outcome<RiskParams> {
  const record = readRecord(root, "risk", "params");
  if (!record.ok) return record;
  const unknown = refuseUnknownKeys(record.value, RISK_KEYS, "params.risk");
  if (!unknown.ok) return unknown;
  const maximumPositionShares = readPositiveField(
    record.value,
    "maximum_position_shares",
    "params.risk",
  );
  if (!maximumPositionShares.ok) return maximumPositionShares;
  const maximumContractualLoss = readNonNegativeField(
    record.value,
    "maximum_contractual_loss",
    "params.risk",
  );
  if (!maximumContractualLoss.ok) return maximumContractualLoss;
  const maximumSlippage = readNonNegativeField(record.value, "maximum_slippage", "params.risk");
  if (!maximumSlippage.ok) return maximumSlippage;
  const participationPrice = readPriceField(
    record.value,
    "maximum_book_participation",
    "params.risk",
  );
  if (!participationPrice.ok) return participationPrice;
  if (participationPrice.value === "0") {
    return bad(
      "params.risk.maximum_book_participation is \"0\", which permits no entry at all; a " +
        "configuration that can never trade is refused rather than run",
    );
  }
  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        maximum_position_shares: maximumPositionShares.value,
        maximum_contractual_loss: maximumContractualLoss.value,
        maximum_slippage: maximumSlippage.value,
        maximum_book_participation: participationPrice.value,
      }),
    ) as RiskParams,
  );
}

/** The one feature key grammar version 2's book-age read may name (ADR-023 §6). */
export const BOOK_AGE_FEATURE_KEY = "quality.input_feed_ages@polymarket.book";

function parseDataQuality(root: PlainRecord, version: number): Outcome<DataQualityParams> {
  const record = readRecord(root, "data_quality", "params");
  if (!record.ok) return record;
  const path = "params.data_quality";
  const v2 = version === STATIC_BRACKET_CONFIG_VERSION_2;
  const unknown = refuseUnknownKeys(record.value, v2 ? DATA_QUALITY_KEYS_V2 : DATA_QUALITY_KEYS, path);
  if (!unknown.ok) return unknown;
  let bookAgeFeatureKey: string | undefined;
  if (v2) {
    const key = readFeatureKeyField(record.value, "book_age_feature_key", path, null);
    if (!key.ok) return key;
    // Pinned to the ONE key whose meaning ADR-023 defines. Any other feature
    // — or another feed's age — would put a number nobody defined as a book
    // age in front of the staleness gate.
    if (key.value !== BOOK_AGE_FEATURE_KEY) {
      return bad(
        `${path}.book_age_feature_key must be "${BOOK_AGE_FEATURE_KEY}" (the age of the ` +
          "composition root's polymarket.book input, ADR-023 §6); any other key is refused " +
          "rather than read as a book age",
      );
    }
    bookAgeFeatureKey = key.value;
  }
  const maximumBookAgeMs = readInteger(record.value, "maximum_book_age_ms", path, 1, MAX_DURATION_MS);
  if (!maximumBookAgeMs.ok) return maximumBookAgeMs;
  const incidentFeatureKey = readFeatureKeyField(
    record.value,
    "incident_feature_key",
    path,
    INCIDENT_FEATURE_ID,
  );
  if (!incidentFeatureKey.ok) return incidentFeatureKey;
  const onStaleBook = readEnum(record.value, "on_stale_book", path, DATA_QUALITY_RESPONSES);
  if (!onStaleBook.ok) return onStaleBook;
  const onIncident = readEnum(record.value, "on_incident", path, DATA_QUALITY_RESPONSES);
  if (!onIncident.ok) return onIncident;
  return ok(
    Object.freeze(
      Object.assign(Object.create(null) as object, {
        maximum_book_age_ms: maximumBookAgeMs.value,
        ...(bookAgeFeatureKey === undefined ? {} : { book_age_feature_key: bookAgeFeatureKey }),
        incident_feature_key: incidentFeatureKey.value,
        on_stale_book: onStaleBook.value,
        on_incident: onIncident.value,
      }),
    ) as DataQualityParams,
  );
}

/**
 * Cross-field rules. Each one refuses a configuration that is internally
 * contradictory — a configuration whose own settings cannot all be honoured is
 * refused at load rather than resolved by precedence at trading time.
 */
function checkCoherence(params: StaticBracketParams): Outcome<null> {
  const passiveWithinCap = lessOrEqual(
    params.entry.execution.passive_price,
    params.entry.execution.maximum_buy_price,
    "params.entry.execution",
  );
  if (!passiveWithinCap.ok) return passiveWithinCap;
  if (!passiveWithinCap.value) {
    return bad(
      `params.entry.execution: passive_price ${params.entry.execution.passive_price} exceeds ` +
        `maximum_buy_price ${params.entry.execution.maximum_buy_price}, so the resting order the ` +
        "configuration describes would breach its own price cap",
    );
  }
  const sizeWithinRisk = lessOrEqual(
    params.entry.size_shares,
    params.risk.maximum_position_shares,
    "params.risk",
  );
  if (!sizeWithinRisk.ok) return sizeWithinRisk;
  if (!sizeWithinRisk.value) {
    return bad(
      `params.risk: maximum_position_shares ${params.risk.maximum_position_shares} is below ` +
        `entry.size_shares ${params.entry.size_shares}, so no entry this configuration describes ` +
        "could ever pass its own risk cap",
    );
  }
  const minimumFillWithinSize = lessOrEqual(
    params.entry.execution.minimum_fill_shares,
    params.entry.size_shares,
    "params.entry.execution",
  );
  if (!minimumFillWithinSize.ok) return minimumFillWithinSize;
  if (!minimumFillWithinSize.value) {
    return bad(
      `params.entry.execution: minimum_fill_shares ${params.entry.execution.minimum_fill_shares} ` +
        `exceeds entry.size_shares ${params.entry.size_shares}`,
    );
  }
  if (params.exit.entry_cutoff_before_close_seconds < params.exit.exit_cutoff_before_close_seconds) {
    return bad(
      "params.exit: entry_cutoff_before_close_seconds " +
        `(${String(params.exit.entry_cutoff_before_close_seconds)}) must be at least ` +
        `exit_cutoff_before_close_seconds (${String(params.exit.exit_cutoff_before_close_seconds)}); ` +
        "otherwise the strategy could open a position after the moment it is required to close one",
    );
  }
  if (params.exit.final_policy === "HOLD_TO_RESOLUTION" && !params.exit.allow_resolution_hold) {
    return bad(
      "params.exit: final_policy is HOLD_TO_RESOLUTION but allow_resolution_hold is false; the " +
        "end-of-market policy and the resolution-hold permission may not contradict each other",
    );
  }
  return ok(null);
}

/**
 * The `paramsSchema` the WP-170 runtime consumes.
 *
 * §9.6 says "JSON Schema/Zod"; the runtime accepts any object exposing
 * `safeParse(value)` and refuses anything else. A purity-restricted package may
 * not import zod (F3/F14, ADR-005 §1), so this is the hand-rolled adapter — and
 * it is the same shape the runtime type-checks, read once at creation.
 *
 * `data` is the validated, frozen, prototype-free params. On failure the
 * `error` is a plain frozen record carrying the stated problem; the runtime
 * renders it into its `PARAMS_REJECTED` refusal.
 */
export const staticBracketParamsSchema = Object.freeze({
  safeParse(value: unknown): ParamsParseResult {
    // `THROUGHPUT-2`: the same answer for the same immutable object — see
    // `PARSED_BY_OBJECT`.
    const cacheable = typeof value === "object" && value !== null;
    if (cacheable) {
      const cached = PARSED_BY_OBJECT.get(value);
      if (cached !== undefined) return cached;
    }
    const result = validateStaticBracketParams(value);
    const parsed: ParamsParseResult = result.ok
      ? Object.freeze({ success: true as const, data: result.value })
      : Object.freeze({
          success: false as const,
          error: Object.freeze({ message: result.problem }),
        });
    if (cacheable && isImmutablePlainData(value)) PARSED_BY_OBJECT.set(value, parsed);
    return parsed;
  },
});

type ParamsParseResult =
  | { readonly success: true; readonly data: StaticBracketParams }
  | { readonly success: false; readonly error: { readonly message: string } };

/**
 * `THROUGHPUT-2` — the parse of each IMMUTABLE params object, by identity.
 *
 * `prepare` (`strategy.ts`) re-validates `ctx.params()` on every callback, and
 * the WP-170 runtime answers `ctx.params()` with ONE object for the run's whole
 * life: its own materialized, deep-frozen, plain-data copy (`packages/strategy-runtime`
 * `context.ts`). Validation is a pure function of the object's contents, and
 * contents that are deep-frozen plain data can never change, so the answer for
 * such an object is computed once and returned again — the same frozen answer,
 * with the same fields and values, that a fresh validation would build.
 *
 * Cached ONLY when {@link isImmutablePlainData} holds, which it checks after
 * validating (so a first sight reads the object exactly as before): every
 * reachable object is frozen, has a plain prototype, and holds only DATA
 * properties. A mutable object, an accessor, a `Map`, or anything the check
 * cannot read is validated afresh on every call, as before. A `WeakMap`, so
 * the cache keeps nothing alive; its size is bounded by the live params
 * objects (one per strategy instance).
 */
const PARSED_BY_OBJECT = new WeakMap<object, ParamsParseResult>();

/**
 * `true` when `value` is a finite tree of frozen, plain-prototype objects and
 * arrays holding only data properties — contents that cannot change. Never
 * throws: a value that cannot be read answers `false`.
 */
export function isImmutablePlainData(value: unknown): boolean {
  try {
    return immutableAt(value, new Set());
  } catch {
    return false;
  }
}

function immutableAt(value: unknown, visiting: Set<object>): boolean {
  if (value === null || typeof value !== "object") return typeof value !== "function";
  if (visiting.has(value)) return true;
  if (!Object.isFrozen(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  const plain =
    prototype === null ||
    prototype === Object.prototype ||
    (prototype === Array.prototype && Array.isArray(value));
  if (!plain) return false;
  visiting.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return false;
    if (!immutableAt(descriptor.value, visiting)) return false;
  }
  return true;
}
