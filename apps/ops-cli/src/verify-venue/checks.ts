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
 * Deliberate narrowings beyond the SDK (each stricter, never looser) are
 * marked NARROWING in comments: the SDK types prices as unbounded
 * `DecimalString`, while handoff SS7.3 requires canonical decimals with prices
 * in [0, 1]; the SDK types some side/status fields as free strings where the
 * documentation enumerates the values.
 *
 * `kind: "fixture"` checks are structurally validated against local fixture
 * files. `kind: "documented"` checks have no meaningful local fixture (for
 * example the SDK ruling); they are validated against the frozen report file
 * (section presence WITH its own official citation) and are reported as
 * DOCUMENTED, never as vacuous PASS.
 */
import type { FieldSpec, ObjectSpec, PayloadSpec } from "./fixtures.js";

export const VERIFICATION_REPORT_PATH = "docs/venue/verified-2026-08-24.md";

/** Official SDK reference commit the raw schemas were verified against. */
export const SDK_REFERENCE_COMMIT =
  "7fdbed42484b5d279c71aa36d3757d18968260da";

/** Permalink prefix every SDK citation must use (never a mutable branch). */
export const SDK_PERMALINK_PREFIX = `https://github.com/Polymarket/ts-sdk/blob/${SDK_REFERENCE_COMMIT}/`;

export interface VenueCheck {
  readonly id: string;
  readonly title: string;
  readonly reportSection: string;
  readonly kind: "fixture" | "documented";
  /** Fixture paths relative to test/fixtures/venue. */
  readonly fixtures: readonly string[];
  /** Source-specific spec every example in each fixture must meet. */
  readonly payloadSpec: PayloadSpec;
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
 * lowercase symbol and no spaces.
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
    // SDK MarketBookEventSchema (subscriptions/clob.ts).
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
] as const;
