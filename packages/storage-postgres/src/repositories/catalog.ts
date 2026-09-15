/**
 * Catalog repository — market identity, versioned rules, versioned parameters.
 *
 * §6 invariant 9: "Market rules, settlement specs, fee schedules, tick sizes,
 * minimum sizes, and delays are versioned. Historical runs use historical
 * parameters." So registering a market and recording its first parameter
 * version is one transaction: a market with no parameter history has no
 * historical parameters to run against.
 */

import type { DecimalString, IsoTimestamp, TokenId } from "@polymarket-bot/domain";

import type { PolymarketBotDatabase } from "../database.js";
import { inTransaction } from "../database.js";
import { withMappedErrors } from "../errors.js";
import { uuidV7 } from "../ids.js";
import { encodeJsonbText } from "../json.js";
import type {
  EventSourceValue,
  MarketLifecycleStateValue,
  OutcomeSideValue,
  TradingParameterKindValue,
} from "../schema/enums.js";
import type { Detail, Identifier, JsonInput, Sha256Hex, UuidV7Column } from "../schema/columns.js";

/** The versioned trading parameters of a market (§9.2, §10.1). */
export type MarketParameters = {
  readonly tickSize: DecimalString;
  readonly minimumOrderSize: DecimalString;
  readonly tradingDelaySeconds: number;
  readonly negRisk: boolean;
  readonly lifecycleState: MarketLifecycleStateValue;
  readonly openTime?: IsoTimestamp | null;
  readonly closeTime?: IsoTimestamp | null;
  readonly feeScheduleId?: UuidV7Column | null;
};

export type RegisterMarketInput = {
  readonly conditionId: Identifier;
  readonly questionTitle: Detail;
  readonly seriesId?: UuidV7Column | null;
  readonly venueEventId?: Identifier | null;
  readonly venueMarketSlug?: Identifier | null;
  readonly parameters: MarketParameters;
  readonly tokens: readonly {
    readonly tokenId: TokenId;
    readonly outcomeSide: OutcomeSideValue;
    readonly outcomeLabel: Identifier;
  }[];
  readonly rawMetadata?: JsonInput;
  readonly source: EventSourceValue;
  readonly observedAt: IsoTimestamp;
};

export type RecordParameterVersionInput = {
  readonly marketId: UuidV7Column;
  readonly changedParameters: readonly TradingParameterKindValue[];
  readonly parameters: MarketParameters;
  readonly source: EventSourceValue;
  readonly observedAt: IsoTimestamp;
  readonly sourceEventId?: string | null;
};

export type RecordRuleVersionInput = {
  readonly marketId: UuidV7Column;
  readonly rulesText: string;
  readonly rulesHash: Sha256Hex;
  readonly sourceUrl?: Detail | null;
  readonly source?: EventSourceValue;
  readonly observedAt: IsoTimestamp;
  readonly makeCurrent?: boolean;
};

export type CatalogRepository = ReturnType<typeof createCatalogRepository>;

export function createCatalogRepository(db: PolymarketBotDatabase) {
  return {
    /**
     * Registers a market together with its outcome tokens and its first
     * parameter version, atomically.
     */
    async registerMarket(input: RegisterMarketInput): Promise<UuidV7Column> {
      const marketId = uuidV7();
      // Venue metadata, recorded as observed and not decimal-guarded — but
      // ENCODED here, default included, so `pg` receives its own bytes rather
      // than a driver serialization through the prototype chain (`SER-2`).
      const rawMetadata = encodeJsonbText(input.rawMetadata ?? {}, "markets.raw_metadata");

      await inTransaction(db, async (trx) => {
        await trx
          .insertInto("catalog.markets")
          .values({
            market_id: marketId,
            condition_id: input.conditionId,
            venue_event_id: input.venueEventId ?? null,
            venue_market_slug: input.venueMarketSlug ?? null,
            series_id: input.seriesId ?? null,
            question_title: input.questionTitle,
            lifecycle_state: input.parameters.lifecycleState,
            current_parameters_version: 1,
            neg_risk: input.parameters.negRisk,
            tick_size: input.parameters.tickSize,
            minimum_order_size: input.parameters.minimumOrderSize,
            trading_delay_seconds: input.parameters.tradingDelaySeconds,
            open_time: input.parameters.openTime ?? null,
            close_time: input.parameters.closeTime ?? null,
            raw_metadata: rawMetadata,
          })
          .execute();

        await trx
          .insertInto("catalog.market_parameter_history")
          .values({
            parameter_version_id: uuidV7(),
            market_id: marketId,
            parameters_version: 1,
            previous_parameters_version: null,
            changed_parameters: [
              "tick_size",
              "minimum_order_size",
              "trading_delay",
              "neg_risk",
              "status",
            ],
            tick_size: input.parameters.tickSize,
            minimum_order_size: input.parameters.minimumOrderSize,
            trading_delay_seconds: input.parameters.tradingDelaySeconds,
            neg_risk: input.parameters.negRisk,
            lifecycle_state: input.parameters.lifecycleState,
            fee_schedule_id: input.parameters.feeScheduleId ?? null,
            open_time: input.parameters.openTime ?? null,
            close_time: input.parameters.closeTime ?? null,
            source: input.source,
            source_event_id: null,
            observed_at: input.observedAt,
          })
          .execute();

        if (input.tokens.length > 0) {
          await trx
            .insertInto("catalog.market_tokens")
            .values(
              input.tokens.map((token) => ({
                market_token_id: uuidV7(),
                market_id: marketId,
                token_id: token.tokenId,
                outcome_side: token.outcomeSide,
                outcome_label: token.outcomeLabel,
              })),
            )
            .execute();
        }
      });

      return marketId;
    },

    /**
     * Appends a new immutable parameter version and repoints the projection.
     *
     * The version number is read inside the transaction, so two concurrent
     * writers cannot both claim the same one: the unique
     * `(market_id, parameters_version)` constraint rejects the loser.
     */
    async recordParameterVersion(input: RecordParameterVersionInput): Promise<number> {
      return inTransaction(db, async (trx) => {
        const current = await trx
          .selectFrom("catalog.markets")
          .select(["current_parameters_version"])
          .where("market_id", "=", input.marketId)
          .forUpdate()
          .executeTakeFirstOrThrow();

        const nextVersion = current.current_parameters_version + 1;

        await trx
          .insertInto("catalog.market_parameter_history")
          .values({
            parameter_version_id: uuidV7(),
            market_id: input.marketId,
            parameters_version: nextVersion,
            previous_parameters_version: current.current_parameters_version,
            changed_parameters: input.changedParameters,
            tick_size: input.parameters.tickSize,
            minimum_order_size: input.parameters.minimumOrderSize,
            trading_delay_seconds: input.parameters.tradingDelaySeconds,
            neg_risk: input.parameters.negRisk,
            lifecycle_state: input.parameters.lifecycleState,
            fee_schedule_id: input.parameters.feeScheduleId ?? null,
            open_time: input.parameters.openTime ?? null,
            close_time: input.parameters.closeTime ?? null,
            source: input.source,
            source_event_id: input.sourceEventId ?? null,
            observed_at: input.observedAt,
          })
          .execute();

        await trx
          .updateTable("catalog.markets")
          .set({
            current_parameters_version: nextVersion,
            tick_size: input.parameters.tickSize,
            minimum_order_size: input.parameters.minimumOrderSize,
            trading_delay_seconds: input.parameters.tradingDelaySeconds,
            neg_risk: input.parameters.negRisk,
            lifecycle_state: input.parameters.lifecycleState,
            open_time: input.parameters.openTime ?? null,
            close_time: input.parameters.closeTime ?? null,
          })
          .where("market_id", "=", input.marketId)
          .execute();

        return nextVersion;
      });
    },

    /** Appends an immutable rule version (§10.7) and optionally repoints it. */
    async recordRuleVersion(input: RecordRuleVersionInput): Promise<UuidV7Column> {
      const ruleVersionId = uuidV7();

      await inTransaction(db, async (trx) => {
        const previous = await trx
          .selectFrom("catalog.market_rule_versions")
          .select(["rules_version"])
          .where("market_id", "=", input.marketId)
          .orderBy("rules_version", "desc")
          .limit(1)
          .executeTakeFirst();

        await trx
          .insertInto("catalog.market_rule_versions")
          .values({
            rule_version_id: ruleVersionId,
            market_id: input.marketId,
            rules_version: (previous?.rules_version ?? 0) + 1,
            rules_text: input.rulesText,
            rules_hash: input.rulesHash,
            source_url: input.sourceUrl ?? null,
            source: input.source ?? "polymarket",
            observed_at: input.observedAt,
          })
          .execute();

        if (input.makeCurrent !== false) {
          await trx
            .updateTable("catalog.markets")
            .set({ current_rule_version_id: ruleVersionId })
            .where("market_id", "=", input.marketId)
            .execute();
        }
      });

      return ruleVersionId;
    },

    /** Reads the current market projection by venue condition id. */
    async findMarketByConditionId(conditionId: Identifier) {
      return withMappedErrors(async () =>
        db
          .selectFrom("catalog.markets")
          .selectAll()
          .where("condition_id", "=", conditionId)
          .executeTakeFirst(),
      );
    },

    /** Reads one historical parameter version (§6 invariant 9). */
    async findParameterVersion(marketId: UuidV7Column, parametersVersion: number) {
      return withMappedErrors(async () =>
        db
          .selectFrom("catalog.market_parameter_history")
          .selectAll()
          .where("market_id", "=", marketId)
          .where("parameters_version", "=", parametersVersion)
          .executeTakeFirst(),
      );
    },
  };
}
