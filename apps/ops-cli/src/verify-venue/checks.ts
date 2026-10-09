/**
 * WP-000 venue verification check catalog.
 *
 * Enumerates the venue facts that handoff SS1.2 requires re-verifying at the
 * start of every implementation phase, maps each to its section in the frozen
 * verification report and to the sanitized fixture files that cover it, and
 * declares a source-specific, recursively nested payload spec per fixture.
 *
 * Raw wire schemas follow the official unified SDK bindings
 * (github.com/Polymarket/ts-sdk, reference commit
 * 7fdbed42484b5d279c71aa36d3757d18968260da; `packages/bindings/src/shared.ts`,
 * `packages/bindings/src/subscriptions/clob.ts`,
 * `packages/bindings/src/clob/account.ts`,
 * `packages/bindings/src/clob/order-response.ts`; raw sources retrieved
 * 2026-08-24, re-verified verbatim against the pinned commit 2026-08-26).
 * The per-market reward settings additionally follow
 * `packages/bindings/src/gamma/common.ts` (`ClobRewardsSchema`) and
 * `packages/bindings/src/gamma/market.ts` (retrieved 2026-08-26 at the same
 * pinned commit).
 *
 * Every SDK-derived spec is `strict`: it enumerates the full field list of its
 * source schema and rejects unexpected keys, so an omitted SDK field cannot
 * hide behind permissive unknown-key acceptance. Heterogeneous fixtures use
 * discriminated variants (`event_type`, `operation`, or the example name) so
 * that no example can pass by making every field optional.
 *
 * FIELD-LIST RE-AUDIT (2026-08-26, round 5). Round-5 review finding MEDIUM-1
 * found the claim above false for one schema: the strict per-market reward
 * spec omitted `MarketRewards.holdingRewardsEnabled`, so a valid parsed object
 * was rejected as carrying an unexpected key. Every other source field list was
 * then re-read verbatim at the pinned commit and compared key-by-key —
 * `MarketPriceChangeEventSchema`, `PriceChangeSchema`,
 * `MarketTickSizeChangeEventSchema`, `MarketLastTradePriceEventSchema`,
 * `MarketBestBidAskEventSchema`, `NewMarketEventSchema` (22 keys),
 * `MarketResolvedEventSchema`, `MarketEventMessageSchema`,
 * `MarketBookEventSchema`, `OrderBookLevelSchema`, `UserOrderEventSchema`
 * (19 keys), `UserTradeEventSchema` (23 keys), `TradeMakerOrderSchema`,
 * `ClobTradeSchema` (18 keys), `MakerOrderSchema`,
 * `OrderResponsePayloadSchema`, `ClobRewardsSchema`, and `MarketRewards` —
 * and no other gap was found.
 *
 * Deliberate narrowings beyond the SDK (each stricter, never looser) are
 * marked NARROWING in comments: the SDK types prices as unbounded
 * `DecimalString`, while handoff SS7.3 requires canonical decimals with prices
 * in [0, 1]; the SDK types some side/status fields as free strings where the
 * documentation enumerates the values.
 *
 * OPTIONALITY vs NULLABILITY (round-5 review finding HIGH). `optional: true`
 * means only that the key may be ABSENT. An explicit `null` is accepted ONLY
 * where the spec also declares `nullable: true`, and every `nullable` in this
 * catalog cites an official published type that documents `| null`. The four
 * documented nullables are `REST_MAKER_ORDER.fee_rate_bps` (SDK
 * `.nullable()`), `TransactionOutcome.transactionId`
 * (`TransactionId | null`), `clobRewards[].endDate`
 * (`IsoCalendarDateString | null`), and `holdingRewardsEnabled`
 * (`boolean | null`). Several SDK schemas use `.nullish()`, so rejecting an
 * explicit `null` for the remaining optional fields is a deliberate
 * NARROWING appropriate to a frozen documentation snapshot; report §17
 * records it, and a runtime adapter must not inherit it.
 *
 * `kind: "fixture"` checks are structurally validated against local fixture
 * files. `kind: "documented"` checks have no meaningful local fixture (for
 * example the SDK ruling); they are validated against the frozen report file
 * (section presence WITH its own official citation) and are reported as
 * DOCUMENTED, never as vacuous PASS.
 *
 * PROTOCOL V2 (V2-9, 2026-10-06). Three checks are validated against
 * `PROTOCOL_V2_REPORT_PATH` (`VENUE-4`'s report) instead of the frozen
 * baseline: `market-ws-book-v2`, `position-operations-v2` and
 * `protocol-v2-captures`. `kind: "capture"` checks validate the raw public
 * captures under `protocol-v2/` against their provenance sidecars
 * (`captures.ts`). Each V2 check names the report ids it pins (`facts`), and
 * the gate requires every id to be defined in that report. An `assert` hook
 * carries a fixture's cross-field facts (a derivation, a verbatim copy from a
 * committed capture, a note that must cite a conflict).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CaptureSpec } from "./captures.js";
import {
  decodePositionId,
  jsonEqual,
  narrowConditionId,
  parseCapture,
  resolvePath,
} from "./captures.js";
import type {
  FieldSpec,
  FixtureFile,
  ObjectSpec,
  PayloadSpec,
} from "./fixtures.js";
import { VENUE_FIXTURE_ROOT, isRecord } from "./fixtures.js";

/**
 * The frozen §1.2 report every baseline check is validated against.
 *
 * WHY IT STAYS (V2-9, CLOSEOUT-3 L11). `verified-2026-10-05.md` is a Protocol
 * V2 delta report, "not a handoff §1.2 phase-gate re-verification" (its own
 * header); its lettered sections (O, S, H, D) do not fit the numbered-section
 * evidence gate below. So V2-9 adds its V2 facts beside this baseline
 * (`PROTOCOL_V2_REPORT_PATH`) rather than re-pointing it. Re-pointing the
 * baseline to a later phase-gate report (2026-09-30) means re-auditing every
 * WP-000 fixture against its drift rows (E-04, E-05, E-09, E-10), two of
 * which wait on rulings (C-9, C-13); that is outside V2-9's Protocol V2
 * scope and stays with L11's owner.
 */
export const VERIFICATION_REPORT_PATH = "docs/venue/verified-2026-08-24.md";

/** The baseline's snapshot date (`retrieved`, `effective_date`). */
export const BASELINE_SNAPSHOT_DATE = "2026-08-24";

/**
 * V2-9: `VENUE-4`'s Protocol V2 and Data API v2 report. The V2 checks and the
 * `protocol-v2/` captures are validated against it: each cited id must be
 * defined in it, and each capture's sidecar must match its source index.
 */
export const PROTOCOL_V2_REPORT_PATH = "docs/venue/verified-2026-10-05.md";

/** The V2 snapshot date (`retrieved`, `effective_date`). */
export const PROTOCOL_V2_SNAPSHOT_DATE = "2026-10-05";

/** Official SDK reference commit the raw schemas were verified against. */
export const SDK_REFERENCE_COMMIT =
  "7fdbed42484b5d279c71aa36d3757d18968260da";

/** Permalink prefix every SDK citation must use (never a mutable branch). */
export const SDK_PERMALINK_PREFIX = `https://github.com/Polymarket/ts-sdk/blob/${SDK_REFERENCE_COMMIT}/`;

export interface VenueCheck {
  readonly id: string;
  readonly title: string;
  /** The section of `report` that records the check's facts. */
  readonly reportSection: string;
  readonly kind: "fixture" | "documented" | "capture";
  /** Fixture paths relative to test/fixtures/venue. */
  readonly fixtures: readonly string[];
  /** Source-specific spec every example in each fixture must meet. */
  readonly payloadSpec: PayloadSpec;
  /**
   * V2-9. The dated report the check is validated against; absent means the
   * frozen baseline, `VERIFICATION_REPORT_PATH`.
   */
  readonly report?: string;
  /**
   * V2-9. The ids of `report` the check pins (`F-62`, `C-21`, `O.2`); each
   * must be defined in it. Required on every check of a non-baseline report.
   */
  readonly facts?: readonly string[];
  /** V2-9. `kind: "capture"`: the committed captures, each with a sidecar. */
  readonly captures?: readonly CaptureSpec[];
  /**
   * V2-9. Cross-field facts a `kind: "fixture"` fixture must meet beyond its
   * payload spec; returns the refusals.
   */
  readonly assert?: (fixture: FixtureFile) => readonly string[];
}

/** The report a check is validated against. */
export function reportOf(check: VenueCheck): string {
  return check.report ?? VERIFICATION_REPORT_PATH;
}

/** The `retrieved` date a check's fixtures must carry. */
export function snapshotDateOf(check: VenueCheck): string {
  return reportOf(check) === PROTOCOL_V2_REPORT_PATH
    ? PROTOCOL_V2_SNAPSHOT_DATE
    : BASELINE_SNAPSHOT_DATE;
}

const SIDE = ["BUY", "SELL"] as const;
const TRADER_SIDE = ["TAKER", "MAKER"] as const;

/** SDK `OrderType` enum (shared.ts). */
const ORDER_TYPE = ["GTC", "FOK", "GTD", "FAK"] as const;

/** SDK `UserOrderStatus` enum (subscriptions/clob.ts). */
const USER_ORDER_STATUS = [
  "LIVE",
  "MATCHED",
  "DELAYED",
  "UNMATCHED",
  "CANCELED",
] as const;

/** SDK `UserOrderEventType` enum (subscriptions/clob.ts). */
const USER_ORDER_EVENT_TYPE = ["PLACEMENT", "UPDATE", "CANCELLATION"] as const;

/**
 * User-channel wire statuses serialize as plain values (SDK shared.ts:
 * "REST endpoints serialize the raw prefixed constants ... while the user
 * websocket channel serializes plain values"). MatchedNotBroadcasted appears
 * only on REST trades, not on user-stream events (SDK TradeStatus doc comment;
 * conflict C-3 in the report). NARROWING: the SDK's `TradeStatusSchema`
 * normalizes both spellings on either layer; the fixtures pin each layer to
 * the spelling its own documentation shows.
 */
const USER_STREAM_TRADE_STATUS = [
  "MATCHED",
  "MINED",
  "CONFIRMED",
  "RETRYING",
  "FAILED",
] as const;

const REST_TRADE_STATUS = [
  "TRADE_STATUS_MATCHED_NOT_BROADCASTED",
  "TRADE_STATUS_MATCHED",
  "TRADE_STATUS_MINED",
  "TRADE_STATUS_CONFIRMED",
  "TRADE_STATUS_RETRYING",
  "TRADE_STATUS_FAILED",
] as const;

/**
 * SDK `EpochLikeToIsoDateTimeStringSchema` accepts an integer epoch, a digit
 * string, or a date-like string. NARROWING: the fixtures pin the epoch forms.
 */
const EPOCH_LIKE: FieldSpec = {
  type: "union",
  oneOf: [{ type: "digit-string" }, { type: "integer" }],
};

/** SDK `ConditionIdSchema`: hex string of 31 or 32 bytes (0x-prefixed). */
const CONDITION_ID: FieldSpec = { type: "hex-string", hexLengths: [64, 66] };

/** SDK `EvmAddressSchema`: 0x-prefixed 20-byte address. */
const EVM_ADDRESS: FieldSpec = { type: "hex-string", hexLengths: [42] };

/** SDK `OrderBookLevelSchema`. NARROWING: price bounded to [0, 1]. */
const ORDER_BOOK_LEVELS: FieldSpec = {
  type: "array",
  items: {
    type: "object",
    strict: true,
    fields: {
      price: { type: "price-string" },
      size: { type: "decimal-string" },
    },
  },
};

/**
 * Raw user-channel trade maker order, per the official SDK
 * `TradeMakerOrderSchema` (packages/bindings/src/subscriptions/clob.ts at the
 * reference commit). `fee_rate_bps` is `OptionalDecimalStringSchema`, so the
 * wire empty string is accepted; `outcome_index` is `z.number().int()`.
 */
const WS_TRADE_MAKER_ORDER: FieldSpec = {
  type: "object",
  strict: true,
  fields: {
    order_id: { type: "string" },
    owner: { type: "string" },
    maker_address: { type: "string", optional: true },
    matched_amount: { type: "decimal-string" },
    price: { type: "price-string" },
    fee_rate_bps: { type: "empty-or-decimal-string", optional: true },
    asset_id: { type: "string" },
    outcome: { type: "string", optional: true },
    outcome_index: { type: "integer", optional: true },
    side: { type: "string", enum: SIDE },
  },
};

/**
 * REST maker order, per the official SDK `MakerOrderSchema`
 * (packages/bindings/src/clob/account.ts at the reference commit). Distinct
 * from the websocket maker order: `maker_address` and `outcome` are REQUIRED,
 * `outcome_index` does not exist, and `fee_rate_bps` is `.nullable()` (the key
 * must be present; the API serializes a missing maker fee rate as `''`).
 */
const REST_MAKER_ORDER: FieldSpec = {
  type: "object",
  strict: true,
  fields: {
    asset_id: { type: "string" },
    fee_rate_bps: { type: "empty-or-decimal-string", nullable: true },
    maker_address: { type: "string" },
    matched_amount: { type: "decimal-string" },
    order_id: { type: "string" },
    outcome: { type: "string" },
    owner: { type: "string" },
    price: { type: "price-string" },
    side: { type: "string", enum: SIDE },
  },
};

/** SDK `MarketEventMessageSchema` (subscriptions/clob.ts). */
const MARKET_EVENT_MESSAGE: FieldSpec = {
  type: "object",
  optional: true,
  strict: true,
  fields: {
    id: { type: "string" },
    ticker: { type: "string", optional: true },
    slug: { type: "string", optional: true },
    title: { type: "string", optional: true },
    description: { type: "string", optional: true },
  },
};

const STRING_ARRAY: FieldSpec = {
  type: "array",
  optional: true,
  items: { type: "string" },
};

/**
 * Documented rate-limit response header names and their value shapes. Header
 * values are strings on the wire; the counter/epoch headers are digit strings,
 * so a boolean or numeric header value is rejected.
 */
const RATE_LIMIT_HEADER_SPECS: Readonly<Record<string, FieldSpec>> = {
  "Retry-After": { type: "digit-string" },
  "Poly-RateLimit-Remaining": { type: "digit-string" },
  "Poly-RateLimit-Reset": { type: "digit-string" },
  "Poly-RateLimit-Tier": { type: "string" },
  "Poly-RateLimit-Warning": { type: "string", enum: ["true", "false"] },
};

const RATE_LIMIT_HEADERS = (names: readonly string[]): FieldSpec => ({
  type: "object",
  strict: true,
  fields: Object.fromEntries(
    names.map((name) => [name, RATE_LIMIT_HEADER_SPECS[name] as FieldSpec]),
  ),
});

const CONFIG_SNAPSHOT_DATE: FieldSpec = {
  type: "string",
  enum: ["2026-08-24"],
};

const FEES_SPEC: PayloadSpec = {
  discriminant: "example-name",
  variants: {
    "fee-model-snapshot": {
      strict: true,
      fields: {
        effective_date: CONFIG_SNAPSHOT_DATE,
        formula: { type: "string" },
        maker_fee_rate: { type: "decimal-string" },
        fee_currency: { type: "string", enum: ["USDC", "pUSD"] },
        rounding_decimal_places: { type: "integer" },
        minimum_charged_fee: { type: "decimal-string" },
        taker_fee_rate_by_category: {
          type: "object",
          values: { type: "decimal-string" },
        },
      },
    },
    "maker-rebate-snapshot": {
      strict: true,
      fields: {
        effective_date: CONFIG_SNAPSHOT_DATE,
        payout_currency: { type: "string", enum: ["USDC", "pUSD"] },
        payout_schedule: { type: "string" },
        minimum_payout: { type: "decimal-string" },
        pool_share_by_category: {
          type: "object",
          values: { type: "decimal-string" },
        },
        weighting: { type: "string" },
        payout_formula: { type: "string" },
      },
    },
    "taker-rebate-snapshot": {
      strict: true,
      fields: {
        effective_date: CONFIG_SNAPSHOT_DATE,
        program_launch: { type: "string" },
        weighted_volume_formula: { type: "string" },
        category_weight_range: {
          type: "object",
          values: { type: "decimal-string" },
        },
        tiers: {
          type: "array",
          items: {
            type: "object",
            strict: true,
            fields: {
              tier: { type: "string" },
              threshold_usd: { type: "decimal-string" },
              rebate_rate: { type: "decimal-string" },
            },
          },
        },
        payout_currency: { type: "string", enum: ["USDC", "pUSD"] },
        payout_schedule: { type: "string" },
        minimum_payout: { type: "decimal-string" },
      },
    },
    "liquidity-rewards-market-settings": {
      strict: true,
      fields: {
        effective_date: CONFIG_SNAPSHOT_DATE,
        sampling_interval_seconds: { type: "integer" },
        samples_per_epoch: { type: "integer" },
        scaling_factor_c: { type: "decimal-string" },
        score_function: { type: "string" },
        single_sided_midpoint_band: {
          type: "object",
          strict: true,
          fields: {
            low: { type: "price-string" },
            high: { type: "price-string" },
          },
        },
        // Per-market liquidity-reward settings.
        //
        // LAYER: this example models the SDK-PARSED representation
        // (`market.rewards`), which is what a `@polymarket/client` consumer
        // sees, NOT the raw Gamma HTTP body. The official market-details page
        // publishes both and they differ for the reward decimals:
        //
        //   - TypeScript tab: `rewardsMinSize?: DecimalString | null`,
        //     `rewardsAmount: DecimalString`, `rewardsDailyRate:
        //     DecimalString`, and its `ClobRewards Example` prints them
        //     QUOTED: `"rewardsMinSize": "100"`, `"rewardsAmount": "10000"`,
        //     `"rewardsDailyRate": "100"`.
        //   - Python tab: `rewards_min_size: Decimal | None`,
        //     `rewards_amount: Decimal`, `rewards_daily_rate: Decimal`.
        //   - API (Gamma) tab: the same fields are typed `number` in the field
        //     table and printed UNQUOTED in the JSON example.
        //
        // These are not contradictory: the SDK bridges them with
        // `DecimalishSchema = z.union([DecimalStringSchema, z.number()
        // .transform(...)])`, which ACCEPTS a JSON number on input and always
        // OUTPUTS a decimal string. This schema therefore rejects the JSON
        // number deliberately — a number here would mean an un-parsed raw
        // Gamma body had leaked into a fixture that claims the parsed layer.
        //
        // Sources (all accessed 2026-08-26):
        //   https://docs.polymarket.com/market-data/market-details
        //   https://github.com/Polymarket/ts-sdk/blob/7fdbed42484b5d279c71aa36d3757d18968260da/packages/bindings/src/gamma/common.ts
        //     (`ClobRewardsSchema`)
        //   https://github.com/Polymarket/ts-sdk/blob/7fdbed42484b5d279c71aa36d3757d18968260da/packages/bindings/src/gamma/market.ts
        //     (`clobRewards`/`rewardsMinSize`/`rewardsMaxSpread` on the market
        //     schema)
        //   https://github.com/Polymarket/ts-sdk/blob/7fdbed42484b5d279c71aa36d3757d18968260da/packages/bindings/src/shared.ts
        //     (`DecimalishSchema`, `ClobRewardIdSchema`,
        //     `ConditionIdResponseSchema`, `IsoCalendarDateStringSchema`)
        //
        // COMPLETE FIELD LIST. The official `MarketRewards` type is
        // `{ clobRewards?: ClobRewards[] | null; rewardsMinSize?:
        // DecimalString | null; rewardsMaxSpread?: number | null;
        // holdingRewardsEnabled?: boolean | null }`
        // (https://docs.polymarket.com/market-data/market-details, re-fetched
        // read-only 2026-08-26) and the SDK schema is
        // `clobRewards: z.array(ClobRewardsSchema).nullish(), rewardsMinSize:
        // DecimalishSchema.nullish(), rewardsMaxSpread: z.number().nullish(),
        // holdingRewardsEnabled: z.boolean().nullish()`
        // (gamma/market.ts at the pinned commit, retrieved 2026-08-26). All
        // four are enumerated below; round-5 review finding MEDIUM-1 found
        // `holdingRewardsEnabled` missing, which made the strict spec reject a
        // valid parsed object.
        market_settings_example: {
          type: "object",
          strict: true,
          fields: {
            // NARROWING: the SDK schema is `DecimalishSchema.nullish()` and
            // the published type is `DecimalString | null`; this frozen
            // snapshot keeps the key present and non-null.
            rewardsMinSize: { type: "decimal-string" },
            // A NUMBER in every published representation — TypeScript
            // `number | null`, Python `float | None`, Gamma field table
            // `number`, SDK `z.number().nullish()`. Deliberately NOT a decimal
            // string: it is a spread in cents, not a monetary amount.
            // NARROWING: kept present and non-null.
            rewardsMaxSpread: { type: "number" },
            // `holdingRewardsEnabled?: boolean | null` (Python
            // `holding_rewards_enabled: bool | None`; Gamma field table
            // "holdingRewardsEnabled | boolean | Indicates if holding rewards
            // are active"; SDK `z.boolean().nullish()`). Optional AND nullable
            // exactly as published — the one field in this object whose
            // documented `| null` is honoured rather than narrowed, because
            // unlike its siblings it is not part of the frozen liquidity
            // snapshot's asserted shape. The Gamma JSON example on the page
            // omits it, so absence is documented too.
            //   https://docs.polymarket.com/market-data/market-details
            //     (re-fetched read-only 2026-08-26)
            //   https://github.com/Polymarket/ts-sdk/blob/7fdbed42484b5d279c71aa36d3757d18968260da/packages/bindings/src/gamma/market.ts
            //     (retrieved 2026-08-26)
            holdingRewardsEnabled: {
              type: "boolean",
              optional: true,
              nullable: true,
            },
            clobRewards: {
              type: "array",
              items: {
                type: "object",
                strict: true,
                fields: {
                  // `ClobRewardIdSchema = z.string().transform(toClobRewardId)`
                  // (shared.ts): a branded STRING. All three published
                  // examples quote it.
                  id: { type: "string" },
                  // NARROWING: `ClobRewardsSchema.conditionId` is
                  // `ConditionIdResponseSchema`, which the SDK comments as
                  // validating "hex syntax without constraining the condition
                  // ID byte length" — unlike `ConditionIdSchema`. The 31/32
                  // byte bound below is this repository's narrowing, kept for
                  // consistency with every other condition id in this catalog.
                  conditionId: CONDITION_ID,
                  // Plain `string`, NOT an EVM address. Both sources agree and
                  // the contrast is deliberate: the sibling `conditionId` gets
                  // the branded `CtfConditionId`/`ConditionIdResponseSchema`
                  // while `assetAddress` is documented as `assetAddress:
                  // string` (Python `asset_address: str`) and implemented as a
                  // bare `z.string()` even though the SDK has an
                  // `EvmAddressSchema` available. An earlier revision narrowed
                  // this to a 20-byte EVM address; that constraint is not
                  // documented anywhere and has been removed.
                  assetAddress: { type: "string" },
                  rewardsAmount: { type: "decimal-string" },
                  rewardsDailyRate: { type: "decimal-string" },
                  // `IsoCalendarDateString` (Python `date`); the Gamma field
                  // table types it `string`. The SDK's
                  // `IsoCalendarDateStringSchema` is a branding transform over
                  // `z.string()` and does NOT enforce `YYYY-MM-DD`, so no
                  // calendar-date syntax is asserted here.
                  startDate: { type: "string" },
                  // Published type `endDate: IsoCalendarDateString | null`
                  // (Python `end_date: date | None`): "Date when the
                  // allocation ends, or `null` when it has no end date."
                  // NARROWING: the SDK schema is
                  // `IsoCalendarDateStringSchema.nullish()` (the key may also
                  // be ABSENT); this catalog follows the published type and
                  // requires the key while allowing `null`.
                  endDate: { type: "string", nullable: true },
                },
              },
            },
          },
        },
      },
    },
  },
};

const RATE_LIMIT_SPEC: PayloadSpec = {
  discriminant: "example-name",
  variants: {
    "response-headers-success": {
      strict: true,
      fields: {
        headers: RATE_LIMIT_HEADERS([
          "Poly-RateLimit-Remaining",
          "Poly-RateLimit-Reset",
          "Poly-RateLimit-Tier",
        ]),
      },
    },
    "response-headers-429": {
      strict: true,
      fields: {
        headers: RATE_LIMIT_HEADERS([
          "Retry-After",
          "Poly-RateLimit-Remaining",
          "Poly-RateLimit-Reset",
          "Poly-RateLimit-Tier",
        ]),
      },
    },
    "response-headers-warning-mode": {
      strict: true,
      fields: {
        headers: RATE_LIMIT_HEADERS([
          "Poly-RateLimit-Warning",
          "Poly-RateLimit-Remaining",
          "Poly-RateLimit-Reset",
          "Poly-RateLimit-Tier",
        ]),
      },
    },
    "per-signer-token-buckets-snapshot": {
      strict: true,
      fields: {
        effective_date: CONFIG_SNAPSHOT_DATE,
        token_costs: { type: "object", values: { type: "string" } },
        batch_admission: { type: "string" },
        tiers: {
          type: "array",
          items: {
            type: "object",
            strict: true,
            fields: {
              tier: { type: "string" },
              volume_30d_usd: { type: "decimal-string" },
              order_tokens_per_s: { type: "integer" },
              order_burst: { type: "integer" },
              cancel_tokens_per_s: { type: "integer" },
              cancel_burst: { type: "integer" },
            },
          },
        },
      },
    },
    "ip-limits-snapshot": {
      strict: true,
      fields: {
        effective_date: CONFIG_SNAPSHOT_DATE,
        enforcement: { type: "string" },
        limits_per_10s: { type: "object", values: { type: "integer" } },
        trading_dual_limits: {
          type: "object",
          values: {
            type: "object",
            strict: true,
            fields: {
              burst_per_10s: { type: "integer" },
              sustained_per_10min: { type: "integer" },
            },
          },
        },
      },
    },
  },
};

/**
 * Matching-engine restricted modes. HTTP 425 is a DOCUMENTED-ABSENCE case:
 * the official page shows the status but no response body (report item U-9),
 * so the variant is strict with `http_status` only — modeling the absence
 * explicitly rather than allowing an unvalidated body.
 */
const RESTRICTED_MODES_SPEC: PayloadSpec = {
  discriminant: "example-name",
  variants: {
    "http-425-engine-restarting-body-undocumented": {
      strict: true,
      fields: { http_status: { type: "integer" } },
    },
    "http-503-cancel-only": {
      strict: true,
      fields: {
        http_status: { type: "integer" },
        body: {
          type: "object",
          strict: true,
          fields: { error: { type: "string" } },
        },
      },
    },
    "http-503-post-only": {
      strict: true,
      fields: {
        http_status: { type: "integer" },
        headers: {
          type: "object",
          strict: true,
          fields: { "Retry-After": { type: "digit-string" } },
        },
        body: {
          type: "object",
          strict: true,
          fields: {
            error: { type: "string" },
            code: { type: "string", enum: ["post_only_mode"] },
            retry_after_seconds: { type: "integer" },
          },
        },
      },
    },
  },
};

const CTF_REQUEST_FIELDS = (
  partitionKey: "partition" | "indexSets",
  withAmount: boolean,
): FieldSpec => ({
  type: "object",
  strict: true,
  fields: {
    collateralToken: EVM_ADDRESS,
    parentCollectionId: { type: "hex-string", hexLengths: [66] },
    conditionId: CONDITION_ID,
    [partitionKey]: { type: "array", items: { type: "integer" } },
    ...(withAmount ? { amount: { type: "decimal-string" } } : {}),
  },
});

/**
 * `TransactionOutcome` handle returned by `transaction.wait()` for CTF
 * split/merge/redeem. The official page shows
 * `outcome.transactionHash: TxHash` and
 * `outcome.transactionId: TransactionId | null` (Python:
 * `outcome.transaction_id: str | None`):
 * https://docs.polymarket.com/trading/positions/manage (accessed 2026-08-26).
 * `transactionId` is therefore `.nullable()` — the key is present but its
 * value may be `null` — and a consumer must not assume a relayer id exists.
 */
const TRANSACTION_OUTCOME: FieldSpec = {
  type: "object",
  strict: true,
  fields: {
    transactionHash: { type: "hex-string", hexLengths: [66] },
    transactionId: { type: "string", nullable: true },
  },
};

const CTF_OPERATION = (
  operation: string,
  partitionKey: "partition" | "indexSets",
  withAmount: boolean,
): ObjectSpec => ({
  strict: true,
  fields: {
    operation: { type: "string", enum: [operation] },
    description: { type: "string" },
    onchain_function: { type: "string" },
    request: CTF_REQUEST_FIELDS(partitionKey, withAmount),
    transaction_outcome: TRANSACTION_OUTCOME,
  },
});

const POSITIONS_SPEC: PayloadSpec = {
  discriminant: { field: "operation" },
  variants: {
    "contract-addresses": {
      strict: true,
      fields: {
        operation: { type: "string", enum: ["contract-addresses"] },
        description: { type: "string" },
        effective_date: CONFIG_SNAPSHOT_DATE,
        contracts: { type: "object", values: EVM_ADDRESS },
      },
    },
    split: CTF_OPERATION("split", "partition", true),
    merge: CTF_OPERATION("merge", "partition", true),
    redeem: CTF_OPERATION("redeem", "indexSets", false),
    "derive-position-id": {
      strict: true,
      fields: {
        operation: { type: "string", enum: ["derive-position-id"] },
        description: { type: "string" },
        oracle: EVM_ADDRESS,
        question_id: { type: "hex-string", hexLengths: [66] },
        outcome_slot_count: { type: "integer" },
        parent_collection_id: { type: "hex-string", hexLengths: [66] },
        index_set: { type: "integer" },
        collateral_token: EVM_ADDRESS,
      },
    },
    "neg-risk-convert": {
      strict: true,
      fields: {
        operation: { type: "string", enum: ["neg-risk-convert"] },
        description: { type: "string" },
        neg_risk: { type: "boolean" },
        adapter: EVM_ADDRESS,
        event_flags: {
          type: "object",
          strict: true,
          fields: {
            enableNegRisk: { type: "boolean" },
            negRiskAugmented: { type: "boolean" },
          },
        },
      },
    },
  },
};

const RTDS_TWAP_TOPIC = [
  "crypto_prices_twap_thirty",
  "crypto_prices_twap_sixty",
] as const;

const RTDS_UPDATE_VARIANT: ObjectSpec = {
  strict: true,
  fields: {
    topic: { type: "string", enum: RTDS_TWAP_TOPIC },
    type: { type: "string", enum: ["update"] },
    timestamp: { type: "integer" },
    payload: {
      type: "object",
      strict: true,
      fields: {
        symbol: { type: "string" },
        value: { type: "number" },
        full_accuracy_value: { type: "digit-string" },
        timestamp: { type: "integer" },
        window_s: { type: "integer" },
      },
    },
  },
};

/**
 * RTDS subscribe frame. `filters` is OPTIONAL: the official Chainlink TWAP
 * page states "Omit it to receive every available symbol" (and then filter on
 * `payload.symbol` client-side):
 * https://docs.polymarket.com/market-data/chainlink-twap (accessed
 * 2026-08-26). When present it must be the exact compact JSON form with one
 * lowercase symbol and no spaces. The page documents exactly two forms —
 * omission or the compact JSON string — and never `filters: null`, so the
 * spec is deliberately NOT `nullable` (round-5 review finding HIGH).
 */
const RTDS_SUBSCRIBE_VARIANT: ObjectSpec = {
  strict: true,
  fields: {
    action: { type: "string", enum: ["subscribe"] },
    subscriptions: {
      type: "array",
      items: {
        type: "object",
        strict: true,
        fields: {
          topic: { type: "string", enum: RTDS_TWAP_TOPIC },
          type: { type: "string", enum: ["update"] },
          filters: { type: "string", optional: true },
        },
      },
    },
  },
};

const RTDS_SPEC: PayloadSpec = {
  discriminant: "example-name",
  variants: {
    "subscribe-request": RTDS_SUBSCRIBE_VARIANT,
    "subscribe-request-all-symbols-no-filters": RTDS_SUBSCRIBE_VARIANT,
    "twap-update-30s": RTDS_UPDATE_VARIANT,
    "twap-update-60s": RTDS_UPDATE_VARIANT,
  },
};

const HEARTBEAT_ID_ONLY: ObjectSpec = {
  strict: true,
  fields: { heartbeat_id: { type: "string" } },
};

const HEARTBEAT_SPEC: PayloadSpec = {
  discriminant: "example-name",
  variants: {
    "bootstrap-request-empty-id": HEARTBEAT_ID_ONLY,
    "bootstrap-response-new-id": HEARTBEAT_ID_ONLY,
    "continuation-request": HEARTBEAT_ID_ONLY,
    "continuation-response-rotated-id": HEARTBEAT_ID_ONLY,
    "response-400-invalid-id-recovery": {
      strict: true,
      fields: {
        heartbeat_id: { type: "string" },
        error_msg: { type: "string" },
      },
    },
  },
};

/**
 * V2-9 (plan acceptance 3). The heartbeat fixture records the guide's
 * `POST /v1/heartbeats` and its `400` keyed `error_msg`. Conflict C-20
 * (`verified-2026-10-05.md` §11, §H-3): the CLOB OpenAPI keys that `400`
 * `error`, and documents a second route, `POST /heartbeats`. The payloads
 * stay as the guide gives them; the notes must cite C-20 and its report, so
 * no consumer reads the fixture as settling the key.
 */
export function assertHeartbeatNotesCiteC20(
  fixture: FixtureFile,
): readonly string[] {
  const errors: string[] = [];
  if (!/\bC-20\b/.test(fixture.notes)) {
    errors.push(
      "notes: must cite conflict C-20 (the 400 key is error_msg in the guide and error in the CLOB OpenAPI; POST /heartbeats is a second documented route)",
    );
  }
  if (!fixture.notes.includes(PROTOCOL_V2_REPORT_PATH)) {
    errors.push(`notes: must name the report that records C-20 (${PROTOCOL_V2_REPORT_PATH})`);
  }
  return errors;
}

// --- Protocol V2 (V2-9) ------------------------------------------------------

/** Reads and parses a committed `protocol-v2/` capture (strict JSON or JSONL). */
function readCaptureView(
  fixture: string,
  format: "json" | "jsonl",
  errors: string[],
): unknown {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(resolve(VENUE_FIXTURE_ROOT, fixture));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${fixture}: unreadable: ${message}`);
    return null;
  }
  const parseErrors: string[] = [];
  const view = parseCapture(bytes, format, parseErrors);
  errors.push(...parseErrors.map((error) => `${fixture}: ${error}`));
  return view;
}

/**
 * The market channel `book` frame for a V2 position id, as observed. SDK
 * `MarketBookEventSchema`'s field list (as `market-ws-book`), plus the
 * undocumented `version` (C-21), REQUIRED here and pinned to `"v2"`: this is
 * the check that a V2 frame carries it, never an authority for it.
 * NARROWING: `market` is the 32-byte, right-padded condition the CLOB serves
 * for V2 (C-19, F-43), and `asset_id` is a decimal string (U-13 resolved;
 * F-44).
 */
const MARKET_WS_BOOK_V2_SPEC: PayloadSpec = {
  strict: true,
  fields: {
    event_type: { type: "string", enum: ["book"] },
    market: { type: "hex-string", hexLengths: [66] },
    asset_id: { type: "digit-string" },
    bids: ORDER_BOOK_LEVELS,
    asks: ORDER_BOOK_LEVELS,
    hash: { type: "string", optional: true },
    timestamp: { type: "digit-string", optional: true },
    min_order_size: { type: "empty-or-decimal-string", optional: true },
    tick_size: { type: "empty-or-price-string", optional: true },
    neg_risk: { type: "boolean", optional: true },
    last_trade_price: { type: "empty-or-price-string", optional: true },
    version: { type: "string", enum: ["v2"] },
  },
};

/**
 * Where each V2 book example was copied from: a line of the committed S-W01
 * session (1-based) and the index of the object in that frame's array.
 */
const MARKET_WS_BOOK_V2_ORIGINS: Readonly<
  Record<string, { readonly capture: string; readonly line: number; readonly element: number }>
> = {
  "book-snapshot-v2-position-id": {
    capture: "protocol-v2/ws-market-v2-session.jsonl",
    line: 3,
    element: 0,
  },
};

/**
 * Each V2 book example must (a) be the committed capture's frame, value for
 * value (plan acceptance 2: "from committed public captures"), and (b) carry a
 * position id whose condition (`asset_id >> 8`) is the frame's `market`
 * narrowed to 31 bytes (F-42, F-44).
 */
export function assertBookV2(fixture: FixtureFile): readonly string[] {
  const errors: string[] = [];
  for (const example of fixture.examples) {
    const where = `examples ${example.name}`;
    const origin = MARKET_WS_BOOK_V2_ORIGINS[example.name];
    if (origin === undefined) {
      errors.push(`${where}: not traced to a committed capture line`);
      continue;
    }
    const view = readCaptureView(origin.capture, "jsonl", errors);
    const frame = resolvePath(view, `[${origin.line - 1}].frame[${origin.element}]`);
    if (!frame.found || !jsonEqual(frame.value, example.payload)) {
      errors.push(
        `${where}: must equal element ${origin.element} of the frame on line ${origin.line} of ${origin.capture}, value for value`,
      );
    }
    const decoded = decodePositionId(example.payload["asset_id"]);
    const condition = narrowConditionId(example.payload["market"]);
    if (decoded === null || condition === null || decoded.conditionBytes31 !== condition) {
      errors.push(`${where}: asset_id >> 8 must be the market's condition narrowed to 31 bytes (F-42, F-44)`);
    }
  }
  return errors;
}

/** Protocol V2 proxy addresses (F-71; S-D07 lines 32-33, 37-38, 48). */
const V2_CONTRACTS = {
  ExchangeV3: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa",
  PositionManager: "0x006F54F7f9A22e0000CC2AB60031000000ae9fEF",
  Router: "0x12121212006e4CD160D18e3f00711DA5c3372600",
  AutoRedeemer: "0xa1200000d0002264C9a1698e001292D00E1b00af",
  pUSD: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB",
} as const;

const documentedAddress = (address: string): FieldSpec => ({
  type: "hex-string",
  hexLengths: [42],
  enum: [address],
});

/** A V2 `bytes31` condition id: `0x` and 62 hex digits (F-43). */
const CONDITION_ID_BYTES31: FieldSpec = { type: "hex-string", hexLengths: [64] };

/** Six-decimal base units, an unsigned integer (F-73; S-D04 line 55). */
const BASE_UNITS: FieldSpec = { type: "digit-string" };

const operationOf = (operation: string): FieldSpec => ({
  type: "string",
  enum: [operation],
});

/** A Router call: the documented ABI signature and its `request` (F-73). */
const ROUTER_CALL = (
  operation: "split" | "merge" | "redeem",
  signature: string,
): ObjectSpec => ({
  strict: true,
  fields: {
    operation: operationOf(operation),
    description: { type: "string" },
    target: documentedAddress(V2_CONTRACTS.Router),
    onchain_function: { type: "string", enum: [signature] },
    request: {
      type: "object",
      strict: true,
      fields: {
        conditionId: CONDITION_ID_BYTES31,
        ...(operation === "redeem" ? { outcomeIndex: { type: "integer" } } : {}),
        amount: BASE_UNITS,
      },
    },
  },
});

/**
 * Polymarket Protocol V2 position operations (plan row D7, the V2 half):
 * Router `split`, `merge` and `redeem`, the approvals they need, the
 * PositionManager payout read, and the id derivations, all from the official
 * pages (S-D04, S-D07, S-D10, S-D12, S-D16, S-D17). Discriminated by
 * `operation`.
 */
const POSITIONS_V2_SPEC: PayloadSpec = {
  discriminant: { field: "operation" },
  variants: {
    "contract-addresses-v2": {
      strict: true,
      fields: {
        operation: operationOf("contract-addresses-v2"),
        description: { type: "string" },
        effective_date: { type: "string", enum: [PROTOCOL_V2_SNAPSHOT_DATE] },
        contracts: {
          type: "object",
          strict: true,
          fields: Object.fromEntries(
            Object.entries(V2_CONTRACTS).map(([name, address]) => [
              name,
              documentedAddress(address),
            ]),
          ),
        },
      },
    },
    approve: {
      strict: true,
      fields: {
        operation: operationOf("approve"),
        description: { type: "string" },
        for_operations: { type: "array", items: { type: "string", enum: ["split"] } },
        token_contract: documentedAddress(V2_CONTRACTS.pUSD),
        onchain_function: {
          type: "string",
          enum: ["approve(address spender, uint256 amount)"],
        },
        spender: documentedAddress(V2_CONTRACTS.Router),
        amount: BASE_UNITS,
      },
    },
    setApprovalForAll: {
      strict: true,
      fields: {
        operation: operationOf("setApprovalForAll"),
        description: { type: "string" },
        for_operations: {
          type: "array",
          items: { type: "string", enum: ["merge", "redeem"] },
        },
        token_contract: documentedAddress(V2_CONTRACTS.PositionManager),
        onchain_function: {
          type: "string",
          enum: ["setApprovalForAll(address operator, bool approved)"],
        },
        operator: documentedAddress(V2_CONTRACTS.Router),
        approved: { type: "boolean" },
      },
    },
    split: ROUTER_CALL("split", "split(bytes31 conditionId, uint256 amount)"),
    merge: ROUTER_CALL("merge", "merge(bytes31 conditionId, uint256 amount)"),
    redeem: ROUTER_CALL(
      "redeem",
      "redeem(bytes31 conditionId, uint256 outcomeIndex, uint256 amount)",
    ),
    "get-payout": {
      strict: true,
      fields: {
        operation: operationOf("get-payout"),
        description: { type: "string" },
        target: documentedAddress(V2_CONTRACTS.PositionManager),
        onchain_function: {
          type: "string",
          enum: [
            "getPayout(uint256 positionId, uint256 amount) view returns (uint256)",
          ],
        },
        request: {
          type: "object",
          strict: true,
          fields: {
            positionId: { type: "digit-string" },
            amount: BASE_UNITS,
          },
        },
      },
    },
    "derive-from-position-id": {
      strict: true,
      fields: {
        operation: operationOf("derive-from-position-id"),
        description: { type: "string" },
        position_id: { type: "digit-string" },
        condition_id: CONDITION_ID_BYTES31,
        outcome_index: { type: "integer" },
      },
    },
    "narrow-padded-condition-id": {
      strict: true,
      fields: {
        operation: operationOf("narrow-padded-condition-id"),
        description: { type: "string" },
        condition_id_bytes32: { type: "hex-string", hexLengths: [66] },
        condition_id_bytes31: CONDITION_ID_BYTES31,
      },
    },
  },
};

/** The documentation examples the Router fixture's ids must come from. */
const V2_DOCS_MARKET = "protocol-v2/gamma-market-v2-docs-example.jsonc"; // S-D16
const V2_DOCS_EVENT = "protocol-v2/gamma-event-v2-docs-example.jsonc"; // S-D17

const positive = (value: unknown): boolean =>
  typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n;

/**
 * The Router fixture's cross-field facts:
 * - every condition id, position id and derivation is the documentation's
 *   (S-D16's `positionIds`, S-D17's `conditionId`), so nothing live or
 *   invented enters `positions/`;
 * - `positionId >> 8` is the condition and `positionId & 255` the outcome
 *   (S-D12 lines 659-665), and a padded `bytes32` narrows only when its final
 *   byte is zero (S-D04 line 54);
 * - redeem takes outcome `0` (YES) or `1` (NO), one call per outcome, both
 *   present (S-D04 line 56; S-D12 lines 625, 754);
 * - merge and redeem need `setApprovalForAll(Router, true)` (S-D04 line 40);
 * - every amount is positive base units.
 */
export function assertRouterV2(fixture: FixtureFile): readonly string[] {
  const errors: string[] = [];
  const market = readCaptureView(V2_DOCS_MARKET, "json", errors);
  const event = readCaptureView(V2_DOCS_EVENT, "json", errors);
  const positionIds = resolvePath(market, "positionIds").value;
  const docsCondition = resolvePath(event, "markets[0].conditionId").value;
  if (!Array.isArray(positionIds) || typeof docsCondition !== "string") {
    errors.push("the documentation examples (S-D16, S-D17) are unreadable");
    return errors;
  }
  const docsIds: readonly unknown[] = positionIds;
  const redeemed: number[] = [];
  const seen = new Set<string>();
  for (const example of fixture.examples) {
    const payload = example.payload;
    const operation = payload["operation"];
    const where = `examples ${example.name}`;
    if (typeof operation === "string") {
      seen.add(operation);
    }
    const request = isRecord(payload["request"]) ? payload["request"] : {};
    switch (operation) {
      case "split":
      case "merge":
      case "redeem": {
        if (request["conditionId"] !== docsCondition) {
          errors.push(`${where}: conditionId must be the documentation's V2 condition (S-D17 line 281)`);
        }
        if (!positive(request["amount"])) {
          errors.push(`${where}: amount must be positive base units`);
        }
        if (operation === "redeem") {
          const outcome = request["outcomeIndex"];
          if (outcome !== 0 && outcome !== 1) {
            errors.push(`${where}: outcomeIndex must be 0 (YES) or 1 (NO) (S-D04 line 56)`);
          } else {
            redeemed.push(outcome);
          }
        }
        break;
      }
      case "approve":
        if (!positive(payload["amount"])) {
          errors.push(`${where}: amount must be positive base units`);
        }
        break;
      case "setApprovalForAll":
        if (payload["approved"] !== true) {
          errors.push(`${where}: approved must be true (S-D04 line 40)`);
        }
        break;
      case "get-payout":
        if (!docsIds.includes(request["positionId"])) {
          errors.push(`${where}: positionId must be one of the documentation's (S-D16)`);
        }
        if (!positive(request["amount"])) {
          errors.push(`${where}: amount must be positive base units`);
        }
        break;
      case "derive-from-position-id": {
        const decoded = decodePositionId(payload["position_id"]);
        if (!docsIds.includes(payload["position_id"]) || decoded === null) {
          errors.push(`${where}: position_id must be one of the documentation's (S-D16)`);
          break;
        }
        if (
          decoded.conditionBytes31 !== payload["condition_id"] ||
          payload["condition_id"] !== docsCondition
        ) {
          errors.push(`${where}: condition_id must be position_id >> 8, the documentation's condition (S-D12 lines 659-665)`);
        }
        if (decoded.outcomeIndex !== payload["outcome_index"]) {
          errors.push(`${where}: outcome_index must be position_id & 255`);
        }
        break;
      }
      case "narrow-padded-condition-id": {
        const narrowed = narrowConditionId(payload["condition_id_bytes32"]);
        if (narrowed === null || narrowed !== payload["condition_id_bytes31"]) {
          errors.push(`${where}: a bytes32 condition narrows only when its final byte is zero, to its first 31 bytes (S-D04 line 54)`);
        }
        if (payload["condition_id_bytes31"] !== docsCondition) {
          errors.push(`${where}: condition_id_bytes31 must be the documentation's condition (S-D17 line 281)`);
        }
        break;
      }
      default:
        break;
    }
  }
  if (
    redeemed.length !== 2 ||
    !redeemed.includes(0) ||
    !redeemed.includes(1)
  ) {
    errors.push("redeem: one call per outcome, outcomes 0 and 1 each once (S-D12 lines 625, 754)");
  }
  for (const required of [
    "contract-addresses-v2",
    "approve",
    "setApprovalForAll",
    "split",
    "merge",
    "redeem",
    "get-payout",
    "derive-from-position-id",
    "narrow-padded-condition-id",
  ]) {
    if (!seen.has(required)) {
      errors.push(`examples: no ${required} example`);
    }
  }
  return errors;
}

/** The V2 condition and position id shapes pins use. */
const HEX_66: FieldSpec = { type: "hex-string", hexLengths: [66] };
const DECIMAL_ID: FieldSpec = { type: "digit-string" };

/**
 * `VENUE-4`'s 20 public captures and the facts each is committed to show
 * (`protocol-v2/README.md` index; `verified-2026-10-05.md` §O, §2, §6, §7,
 * §9). The paths keep their `.jsonc` and `.jsonl` suffixes: renaming them
 * needs the readers outside V2-9's paths changed too (V2-9 handoff,
 * `stopped_items`). The claim gate now covers every suffix, so the suffix no
 * longer keeps a file outside the gate.
 */
export const PROTOCOL_V2_CAPTURES: readonly CaptureSpec[] = [
  {
    fixture: "protocol-v2/gamma-market-v2-docs-example.jsonc",
    format: "json",
    sourceId: "S-D16",
    pins: [
      { path: "version", equals: "v2", facts: ["F-40"] },
      { path: "clobTokenIds", equals: null, facts: ["F-40"] },
      { path: "positionIds[0]", spec: DECIMAL_ID, facts: ["F-40", "F-38"] },
      { path: "positionIds[1]", spec: DECIMAL_ID, facts: ["F-40", "F-38"] },
      { path: "positionIds[2]", absent: true, facts: ["F-40"] },
    ],
  },
  {
    fixture: "protocol-v2/gamma-event-v2-docs-example.jsonc",
    format: "json",
    sourceId: "S-D17",
    pins: [
      { path: "markets[0].version", equals: "v2", facts: ["F-40"] },
      { path: "markets[0].conditionId", spec: CONDITION_ID_BYTES31, facts: ["F-43"] },
      { path: "markets[0].positionIds[0]", positionIdOf: "markets[0].conditionId", outcomeIndex: 0, facts: ["F-42", "F-44"] },
      { path: "markets[0].positionIds[1]", positionIdOf: "markets[0].conditionId", outcomeIndex: 1, facts: ["F-42", "F-44"] },
    ],
  },
  {
    fixture: "protocol-v2/gamma-market-v1-btc15m.jsonc",
    format: "json",
    sourceId: "S-G04",
    pins: [
      { path: "version", equals: "v1", facts: ["F-38", "O.1"] },
      { path: "clobTokenIds", spec: { type: "string" }, facts: ["F-38"] },
      { path: "positionIds", absent: true, facts: ["O.1"] },
      { path: "resolutionStatus", absent: true, facts: ["O.1"] },
    ],
  },
  {
    fixture: "protocol-v2/gamma-events-keyset-series10192.jsonc",
    format: "json",
    sourceId: "S-G05",
    pins: [
      { path: "events[0].markets[0].version", equals: "v1", facts: ["O.5"] },
      { path: "events[1].markets[0].version", equals: "v1", facts: ["O.5"] },
      { path: "events[0].markets[0].positionIds", absent: true, facts: ["O.5"] },
      { path: "events[0].markets[0].conditionId", spec: HEX_66, facts: ["O.5"] },
      { path: "next_cursor", spec: { type: "string" }, facts: ["O.5"] },
    ],
  },
  {
    fixture: "protocol-v2/clob-markets-v2.jsonc",
    format: "json",
    sourceId: "S-L01",
    pins: [
      { path: "v", equals: "v2", facts: ["O.3", "C-21"] },
      { path: "c", spec: HEX_66, facts: ["O.3", "C-19"] },
      { path: "t[0].o", equals: "Up", facts: ["O.3"] },
      { path: "t[1].o", equals: "Down", facts: ["O.3"] },
      { path: "t[0].t", positionIdOf: "c", outcomeIndex: 0, facts: ["F-44"] },
      { path: "t[1].t", positionIdOf: "c", outcomeIndex: 1, facts: ["F-44"] },
    ],
  },
  {
    fixture: "protocol-v2/clob-markets-v2-62hex-not-found.jsonc",
    format: "json",
    sourceId: "S-L02",
    pins: [{ path: "error", equals: "market not found", facts: ["F-70", "C-19"] }],
  },
  {
    fixture: "protocol-v2/clob-markets-v1.jsonc",
    format: "json",
    sourceId: "S-L10",
    pins: [
      { path: "v", equals: "v1", facts: ["O.3"] },
      { path: "c", spec: HEX_66, facts: ["O.3"] },
      { path: "t[0].o", equals: "Up", facts: ["O.3"] },
      { path: "t[1].o", equals: "Down", facts: ["O.3"] },
      { path: "cbos", absent: true, facts: ["O.3"] },
    ],
  },
  {
    fixture: "protocol-v2/book-v2.jsonc",
    format: "json",
    sourceId: "S-L03",
    pins: [
      { path: "version", equals: "v2", facts: ["O.2", "C-21"] },
      { path: "asset_id", spec: DECIMAL_ID, facts: ["O.2", "F-76"] },
      { path: "market", spec: HEX_66, facts: ["O.2", "C-19"] },
    ],
  },
  {
    fixture: "protocol-v2/book-v1.jsonc",
    format: "json",
    sourceId: "S-L11",
    pins: [
      { path: "version", absent: true, facts: ["O.2", "C-21"] },
      { path: "asset_id", spec: DECIMAL_ID, facts: ["O.2"] },
    ],
  },
  {
    fixture: "protocol-v2/ws-market-v2-session.jsonl",
    format: "jsonl",
    sourceId: "S-W01",
    pins: [
      { path: "[0].dir", equals: "open", facts: ["F-76"] },
      { path: "[0].data", equals: "wss://ws-subscriptions-clob.polymarket.com/ws/market", facts: ["F-76"] },
      { path: "[1].frame.type", equals: "market", facts: ["F-60"] },
      { path: "[1].frame.assets_ids[0]", spec: DECIMAL_ID, facts: ["F-60"] },
      { path: "[2].frame[0].event_type", equals: "book", facts: ["F-62"] },
      { path: "[2].frame[0].version", equals: "v2", facts: ["F-62", "C-21"] },
      { path: "[2].frame[0].asset_id", sameAs: "[1].frame.assets_ids[0]", facts: ["F-60", "F-62"] },
      { path: "[11].frame.event_type", equals: "new_market", facts: ["F-62"] },
      { path: "[11].frame.version", absent: true, facts: ["F-62"] },
      { path: "[15].dir", equals: "close", facts: ["F-62"] },
      { path: "[15].data.code", equals: 1000, facts: ["F-62"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-resolutions-v2-active.jsonc",
    format: "json",
    sourceId: "S-L04",
    pins: [
      { path: "data[0].status", equals: "active", facts: ["F-59"] },
      { path: "data[0].market_type", equals: "BINARY", facts: ["F-59"] },
      { path: "data[0].payouts", absent: true, facts: ["F-59"] },
      { path: "data[0].condition_id", spec: HEX_66, facts: ["F-65", "C-19"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-resolutions-v2-resolved.jsonc",
    format: "json",
    sourceId: "S-A11",
    pins: [
      { path: "data[0].status", equals: "resolved", facts: ["F-59", "F-57"] },
      { path: "data[0].reporter", equals: "CHAINLINK", facts: ["F-59"] },
      { path: "data[0].payouts", equals: [1000000, 0], facts: ["F-59", "F-57"] },
      { path: "data[0].market_type", equals: "BINARY", facts: ["F-59"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-resolutions-v1-resolved.jsonc",
    format: "json",
    sourceId: "S-A10",
    pins: [
      { path: "data[0].status", equals: "resolved", facts: ["F-59"] },
      { path: "data[0].payouts", equals: [0, 1000000], facts: ["F-59"] },
      { path: "data[0].reporter", absent: true, facts: ["F-59"] },
      { path: "data[0].market_type", absent: true, facts: ["F-59"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-resolutions-62hex-invalid.jsonc",
    format: "json",
    sourceId: "S-L05",
    pins: [
      { path: "code", equals: "invalid_request", facts: ["F-70", "C-19"] },
      { path: "parameter", equals: "condition", facts: ["F-70"] },
      { path: "retryable", equals: false, facts: ["F-70", "F-66"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-prices-history-page1.jsonc",
    format: "json",
    sourceId: "S-A02",
    pins: [
      { path: "pagination.offset", equals: 0, facts: ["F-68"] },
      { path: "pagination.limit", equals: 3, facts: ["F-68"] },
      { path: "pagination.has_more", equals: true, facts: ["F-68", "F-66"] },
      { path: "pagination.next_cursor", spec: { type: "string" }, facts: ["F-68", "F-66"] },
      { path: "data[2]", spec: { type: "object", values: { type: "number" } }, facts: ["F-65"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-prices-history-page2.jsonc",
    format: "json",
    sourceId: "S-A03",
    pins: [
      { path: "pagination.offset", equals: 3, facts: ["F-68"] },
      { path: "pagination.limit", equals: 3, facts: ["F-68", "F-66"] },
      { path: "pagination.next_cursor", spec: { type: "string" }, facts: ["F-68"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-trades-v1-page1.jsonc",
    format: "json",
    sourceId: "S-A08",
    pins: [
      { path: "pagination.offset", equals: 0, facts: ["F-69"] },
      { path: "pagination.limit", equals: 2, facts: ["F-69"] },
      { path: "pagination.has_more", equals: true, facts: ["F-69"] },
      { path: "data[1].condition_id", spec: HEX_66, facts: ["F-69", "F-65"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-trades-v1-page2.jsonc",
    format: "json",
    sourceId: "S-A09",
    pins: [
      { path: "pagination.offset", equals: 2, facts: ["F-69"] },
      { path: "pagination.has_more", equals: true, facts: ["F-69"] },
      { path: "data[1].condition_id", spec: HEX_66, facts: ["F-69"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-trades-v2-empty.jsonc",
    format: "json",
    sourceId: "S-A07",
    pins: [
      { path: "data", equals: [], facts: ["F-69"] },
      { path: "pagination.has_more", equals: false, facts: ["F-69", "F-66"] },
      { path: "pagination.next_cursor", equals: null, facts: ["F-69", "F-66"] },
    ],
  },
  {
    fixture: "protocol-v2/data-v2-oi-v2.jsonc",
    format: "json",
    sourceId: "S-A06",
    pins: [
      { path: "data[0].value", equals: 0, facts: ["F-69"] },
      { path: "data[0].condition_id", spec: HEX_66, facts: ["F-69"] },
      { path: "pagination", absent: true, facts: ["F-69"] },
    ],
  },
];

export const VENUE_CHECKS: readonly VenueCheck[] = [
  {
    id: "sdk-and-runtime",
    title:
      "Unified SDK @polymarket/client on Node >=24; archived CLOB clients rejected",
    reportSection: "1",
    kind: "documented",
    fixtures: [],
    payloadSpec: {},
  },
  {
    id: "order-schemas-and-types",
    title:
      "Order request/response schemas; GTC/GTD/FOK/FAK and expiration rules; delayed responses",
    reportSection: "2",
    kind: "fixture",
    fixtures: ["orders/order-responses.json"],
    // SDK OrderResponsePayloadSchema (clob/order-response.ts): every field
    // required except tradeIDs/transactionsHashes, which carry `.default([])`.
    // makingAmount/takingAmount are preprocessed from '' to '0'.
    // `.default([])` supplies the array when the key is ABSENT and rejects an
    // explicit `null`, so neither array is `nullable` here — matching the SDK
    // exactly, not narrowing it (round-5 review finding HIGH; schema
    // re-verified verbatim at the pinned commit 2026-08-26).
    // NARROWING: `status` is `z.string()` in the SDK; the documented placement
    // statuses plus the empty failure value are enumerated here.
    payloadSpec: {
      strict: true,
      fields: {
        success: { type: "boolean" },
        errorMsg: { type: "string" },
        orderID: { type: "string" },
        status: {
          type: "string",
          enum: ["live", "matched", "delayed", "unmatched", ""],
        },
        makingAmount: { type: "empty-or-decimal-string" },
        takingAmount: { type: "empty-or-decimal-string" },
        transactionsHashes: {
          type: "array",
          optional: true,
          items: { type: "string" },
        },
        tradeIDs: { type: "array", optional: true, items: { type: "string" } },
      },
    },
  },
  {
    id: "market-ws-book",
    title: "Market channel book snapshot",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/book-snapshot.json"],
    // SDK MarketBookEventSchema (subscriptions/clob.ts), re-verified verbatim
    // at the pinned commit 2026-08-26: event_type, market, asset_id, bids,
    // asks, hash, timestamp, min_order_size, tick_size, neg_risk,
    // last_trade_price — the complete field list.
    // NARROWING: the SDK marks `hash`, `timestamp` and `neg_risk`
    // `.nullish()`, so it would accept an explicit `null`; the documented book
    // event always carries a string `hash`, so this frozen snapshot accepts
    // ABSENCE but rejects `hash: null` (round-5 review finding HIGH). Report
    // §17 records the narrowing; a runtime adapter must not inherit it.
    payloadSpec: {
      strict: true,
      fields: {
        event_type: { type: "string", enum: ["book"] },
        market: { type: "string" },
        asset_id: { type: "string" },
        bids: ORDER_BOOK_LEVELS,
        asks: ORDER_BOOK_LEVELS,
        hash: { type: "string", optional: true },
        timestamp: { type: "digit-string", optional: true },
        min_order_size: { type: "empty-or-decimal-string", optional: true },
        tick_size: { type: "empty-or-price-string", optional: true },
        neg_risk: { type: "boolean", optional: true },
        last_trade_price: { type: "empty-or-price-string", optional: true },
      },
    },
  },
  {
    id: "market-ws-price-change",
    title:
      "Market channel price change (absolute-size zero-removal example is UNVERIFIED, conflict C-1)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/price-change.json"],
    // SDK MarketPriceChangeEventSchema / PriceChangeSchema.
    payloadSpec: {
      strict: true,
      fields: {
        event_type: { type: "string", enum: ["price_change"] },
        market: { type: "string" },
        price_changes: {
          type: "array",
          items: {
            type: "object",
            strict: true,
            fields: {
              asset_id: { type: "string" },
              price: { type: "price-string" },
              size: { type: "decimal-string" },
              side: { type: "string", enum: SIDE },
              hash: { type: "string", optional: true },
              best_bid: { type: "empty-or-price-string", optional: true },
              best_ask: { type: "empty-or-price-string", optional: true },
            },
          },
        },
        timestamp: { type: "digit-string", optional: true },
      },
    },
  },
  {
    id: "market-ws-tick-size",
    title: "Market channel tick-size change (dynamic tick size)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/tick-size-change.json"],
    // SDK MarketTickSizeChangeEventSchema: old_tick_size is optional
    // (OptionalDecimalStringSchema), new_tick_size is required.
    payloadSpec: {
      strict: true,
      fields: {
        event_type: { type: "string", enum: ["tick_size_change"] },
        market: { type: "string" },
        asset_id: { type: "string" },
        old_tick_size: { type: "empty-or-price-string", optional: true },
        new_tick_size: { type: "price-string" },
        timestamp: { type: "digit-string", optional: true },
      },
    },
  },
  {
    id: "market-ws-last-trade",
    title: "Market channel last trade price",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/last-trade-price.json"],
    // SDK MarketLastTradePriceEventSchema: size and fee_rate_bps are
    // OptionalDecimalStringSchema (the wire empty string is accepted).
    payloadSpec: {
      strict: true,
      fields: {
        event_type: { type: "string", enum: ["last_trade_price"] },
        market: { type: "string" },
        asset_id: { type: "string" },
        price: { type: "price-string" },
        size: { type: "empty-or-decimal-string", optional: true },
        fee_rate_bps: { type: "empty-or-decimal-string", optional: true },
        side: { type: "string", enum: SIDE },
        timestamp: { type: "digit-string", optional: true },
        transaction_hash: { type: "string", optional: true },
      },
    },
  },
  {
    id: "market-ws-best-bid-ask",
    title: "Market channel best bid/ask (enhanced)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/best-bid-ask.json"],
    // SDK MarketBestBidAskEventSchema: all three decimals are
    // OptionalDecimalStringSchema. The frozen example still carries non-empty
    // best_bid/best_ask (asserted separately in the test suite).
    payloadSpec: {
      strict: true,
      fields: {
        event_type: { type: "string", enum: ["best_bid_ask"] },
        market: { type: "string" },
        asset_id: { type: "string" },
        best_bid: { type: "empty-or-price-string", optional: true },
        best_ask: { type: "empty-or-price-string", optional: true },
        spread: { type: "empty-or-price-string", optional: true },
        timestamp: { type: "digit-string", optional: true },
      },
    },
  },
  {
    id: "market-ws-lifecycle",
    title: "Market channel lifecycle events (new_market, market_resolved)",
    reportSection: "3",
    kind: "fixture",
    fixtures: ["market-ws/lifecycle.json"],
    // SDK NewMarketEventSchema / MarketResolvedEventSchema are distinct
    // shapes, so they are validated as discriminated variants rather than as
    // one all-optional union. `id` is REQUIRED on both.
    payloadSpec: {
      discriminant: { field: "event_type" },
      variants: {
        new_market: {
          strict: true,
          fields: {
            event_type: { type: "string", enum: ["new_market"] },
            id: { type: "string" },
            question: { type: "string", optional: true },
            market: { type: "string" },
            slug: { type: "string", optional: true },
            description: { type: "string", optional: true },
            assets_ids: STRING_ARRAY,
            outcomes: STRING_ARRAY,
            event_message: MARKET_EVENT_MESSAGE,
            timestamp: { type: "digit-string", optional: true },
            tags: STRING_ARRAY,
            condition_id: { ...CONDITION_ID, optional: true },
            active: { type: "boolean", optional: true },
            clob_token_ids: STRING_ARRAY,
            sports_market_type: { type: "string", optional: true },
            line: { type: "empty-or-decimal-string", optional: true },
            game_start_time: { ...EPOCH_LIKE, optional: true },
            order_price_min_tick_size: {
              type: "empty-or-price-string",
              optional: true,
            },
            group_item_title: { type: "string", optional: true },
            taker_base_fee: { type: "empty-or-decimal-string", optional: true },
            fees_enabled: { type: "boolean", optional: true },
            fee_schedule: { type: "unknown", optional: true },
          },
        },
        market_resolved: {
          strict: true,
          fields: {
            event_type: { type: "string", enum: ["market_resolved"] },
            id: { type: "string" },
            market: { type: "string" },
            assets_ids: STRING_ARRAY,
            winning_asset_id: { type: "string", optional: true },
            winning_outcome: { type: "string", optional: true },
            event_message: MARKET_EVENT_MESSAGE,
            timestamp: { type: "digit-string", optional: true },
            tags: STRING_ARRAY,
          },
        },
      },
    },
  },
  {
    id: "user-ws-order-lifecycle",
    title:
      "User channel order lifecycle (PLACEMENT/UPDATE/CANCELLATION; LIVE/MATCHED/DELAYED/UNMATCHED/CANCELED)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["user-ws/order-lifecycle.json"],
    // SDK UserOrderEventSchema (subscriptions/clob.ts), full field list.
    payloadSpec: {
      strict: true,
      fields: {
        event_type: { type: "string", enum: ["order"] },
        id: { type: "string" },
        owner: { type: "string" },
        market: { type: "string" },
        asset_id: { type: "string" },
        side: { type: "string", enum: SIDE },
        order_owner: { type: "string", optional: true },
        original_size: { type: "decimal-string" },
        size_matched: { type: "decimal-string" },
        price: { type: "price-string" },
        associate_trades: STRING_ARRAY,
        outcome: { type: "string", optional: true },
        type: { type: "string", enum: USER_ORDER_EVENT_TYPE },
        created_at: { type: "digit-string", optional: true },
        expiration: { type: "digit-string", optional: true },
        order_type: { type: "string", enum: ORDER_TYPE, optional: true },
        status: { type: "string", enum: USER_ORDER_STATUS, optional: true },
        maker_address: { type: "string", optional: true },
        timestamp: { type: "digit-string" },
      },
    },
  },
  {
    id: "user-ws-trade-settlement",
    title:
      "User channel RAW trade events per official SDK UserTradeEventSchema (plain wire statuses; MATCHED_NOT_BROADCASTED is REST-only, C-3)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["user-ws/trade-settlement.json"],
    // SDK UserTradeEventSchema (subscriptions/clob.ts), full field list
    // including the `matchtime` alias of `match_time`.
    payloadSpec: {
      strict: true,
      fields: {
        event_type: { type: "string", enum: ["trade"] },
        type: { type: "string", enum: ["TRADE"] },
        id: { type: "string" },
        taker_order_id: { type: "string" },
        market: { type: "string" },
        asset_id: { type: "string" },
        side: { type: "string", enum: SIDE },
        size: { type: "decimal-string" },
        fee_rate_bps: { type: "empty-or-decimal-string", optional: true },
        price: { type: "price-string" },
        status: { type: "string", enum: USER_STREAM_TRADE_STATUS },
        match_time: { type: "digit-string", optional: true },
        matchtime: { type: "digit-string", optional: true },
        last_update: { type: "digit-string", optional: true },
        outcome: { type: "string", optional: true },
        owner: { type: "string" },
        trade_owner: { type: "string", optional: true },
        maker_address: { type: "string", optional: true },
        transaction_hash: { type: "string", optional: true },
        bucket_index: { type: "integer", optional: true },
        maker_orders: {
          type: "array",
          optional: true,
          items: WS_TRADE_MAKER_ORDER,
        },
        trader_side: { type: "string", enum: TRADER_SIDE, optional: true },
        timestamp: { type: "digit-string" },
      },
    },
  },
  {
    id: "rest-trade-settlement",
    title:
      "REST trade reads with prefixed TRADE_STATUS_* constants incl. MATCHED_NOT_BROADCASTED (REST-only per SDK, C-3)",
    reportSection: "4",
    kind: "fixture",
    fixtures: ["orders/rest-trades.json"],
    // SDK ClobTradeSchema (clob/account.ts), full field list. Unlike the
    // websocket trade event, EVERY field is required and `bucket_index` is
    // `z.number()` (not `.int()`).
    payloadSpec: {
      strict: true,
      fields: {
        asset_id: { type: "string" },
        bucket_index: { type: "number" },
        fee_rate_bps: { type: "decimal-string" },
        id: { type: "string" },
        last_update: EPOCH_LIKE,
        maker_address: { type: "string" },
        maker_orders: { type: "array", items: REST_MAKER_ORDER },
        market: CONDITION_ID,
        match_time: EPOCH_LIKE,
        outcome: { type: "string" },
        owner: { type: "string" },
        price: { type: "price-string" },
        side: { type: "string", enum: SIDE },
        size: { type: "decimal-string" },
        status: { type: "string", enum: REST_TRADE_STATUS },
        taker_order_id: { type: "string" },
        trader_side: { type: "string", enum: TRADER_SIDE },
        transaction_hash: { type: "string" },
      },
    },
  },
  {
    id: "heartbeat",
    title:
      "Order heartbeat protocol (POST /v1/heartbeats; empty-ID bootstrap; ID rotation; 5s cadence, 10s timeout)",
    reportSection: "5",
    kind: "fixture",
    fixtures: ["heartbeat/heartbeat.json"],
    payloadSpec: HEARTBEAT_SPEC,
    // V2-9 (plan acceptance 3): the notes cite C-20.
    assert: assertHeartbeatNotesCiteC20,
  },
  {
    id: "fees-and-rewards",
    title:
      "Fee and reward parameter snapshots (taker fees, maker/taker rebates, liquidity rewards)",
    reportSection: "6",
    kind: "fixture",
    fixtures: ["fees/fee-reward-parameters.json"],
    payloadSpec: FEES_SPEC,
  },
  {
    id: "per-market-parameters",
    title:
      "Per-market trading parameters (dynamic tick size, min size, negRisk, secondsDelay)",
    reportSection: "7",
    kind: "documented",
    fixtures: [],
    payloadSpec: {},
  },
  {
    id: "rate-limits",
    title: "IP and per-signer rate limits as configuration snapshots",
    reportSection: "8",
    kind: "fixture",
    fixtures: ["rate-limits/rate-limits.json"],
    payloadSpec: RATE_LIMIT_SPEC,
  },
  {
    id: "restricted-modes",
    title:
      "Matching-engine restricted modes (HTTP 425 restart, cancel-only, post-only)",
    reportSection: "9",
    kind: "fixture",
    fixtures: ["orders/restricted-modes.json"],
    payloadSpec: RESTRICTED_MODES_SPEC,
  },
  {
    id: "geoblock",
    title: "Geographic restriction check responses",
    reportSection: "10.1",
    kind: "fixture",
    fixtures: ["geoblock/geoblock.json"],
    payloadSpec: {
      strict: true,
      fields: {
        blocked: { type: "boolean" },
        ip: { type: "string" },
        country: { type: "string" },
        region: { type: "string" },
      },
    },
  },
  {
    id: "position-operations",
    title:
      "CTF split/merge/redeem workflows, contract addresses, and position-id derivation",
    reportSection: "10.2",
    kind: "fixture",
    fixtures: ["positions/split-merge-redeem.json"],
    payloadSpec: POSITIONS_SPEC,
  },
  {
    id: "chainlink-twap-rtds",
    title:
      "Chainlink TWAP over RTDS (30s/60s windows, no replay after disconnect)",
    reportSection: "10.3",
    kind: "fixture",
    fixtures: ["rtds/twap-update.json"],
    payloadSpec: RTDS_SPEC,
  },
  // --- Protocol V2 (V2-9), validated against PROTOCOL_V2_REPORT_PATH ---------
  {
    id: "market-ws-book-v2",
    title:
      "Market channel book snapshot for a V2 position id, with the undocumented \"version\":\"v2\" (C-21; plan row D8)",
    reportSection: "7",
    kind: "fixture",
    fixtures: ["market-ws/book-snapshot-v2.json"],
    payloadSpec: MARKET_WS_BOOK_V2_SPEC,
    report: PROTOCOL_V2_REPORT_PATH,
    facts: ["F-62", "C-21", "F-44", "S-W01"],
    assert: assertBookV2,
  },
  {
    id: "position-operations-v2",
    title:
      "Polymarket Protocol V2 Router split/merge/redeem, approvals, PositionManager payout read and id derivations (plan row D7, V2 half)",
    reportSection: "11",
    kind: "fixture",
    fixtures: ["positions/router-v2.json"],
    payloadSpec: POSITIONS_V2_SPEC,
    report: PROTOCOL_V2_REPORT_PATH,
    facts: ["F-71", "F-73", "F-49", "F-43", "F-42", "S-D04", "S-D12"],
    assert: assertRouterV2,
  },
  {
    id: "protocol-v2-captures",
    title:
      "Protocol V2 and Data API v2 public captures: sidecar provenance, digests, report source index, personal-data rules, pinned facts (plan row D9)",
    reportSection: "15",
    kind: "capture",
    fixtures: [],
    payloadSpec: {},
    report: PROTOCOL_V2_REPORT_PATH,
    facts: ["F-69", "C-21"],
    captures: PROTOCOL_V2_CAPTURES,
  },
] as const;
