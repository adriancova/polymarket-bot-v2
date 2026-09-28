/**
 * `@polymarket-bot/trader/testing` — a facade (ADR-022 D7).
 *
 * The test doubles for the trader's infrastructure ports moved with the
 * trading core to `@polymarket-bot/trading-core/testing` (`CORE-MOVE`). This
 * entry re-exports every one of them under the same name and kind, so its
 * importers keep working until a later round retires it.
 */

export * from "@polymarket-bot/trading-core/testing";
