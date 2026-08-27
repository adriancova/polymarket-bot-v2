/**
 * Boundary behavior of the typed repositories.
 *
 * §6 invariant 1: economic values are decimal strings at boundaries. A round
 * trip through PostgreSQL must return the same canonical string, character for
 * character — if it came back as `1.50` or as a `number`, every downstream
 * equality, hash, and unique constraint would be reasoning about a different
 * value from the one that was written.
 *
 * §6 invariant 9: historical runs use historical parameters, so a parameter
 * change must leave the previous version readable.
 */

import type { TestContext } from "@polymarket-bot/storage-postgres/testing";
import { createTradingChain, fixtureTimestamp, hashOf } from "@polymarket-bot/storage-postgres/testing";
import { AppendOnlyViolationError, uuidV7 } from "@polymarket-bot/storage-postgres";
import { beforeAll, describe, expect, it } from "vitest";

import { captureRejection, useMigratedDatabase } from "./context.js";

const getContext = useMigratedDatabase("repositories");

let context: TestContext;
let chain: Awaited<ReturnType<typeof createTradingChain>>;

beforeAll(async () => {
  context = getContext();
  chain = await createTradingChain(context, { label: "repos" });
});

describe("decimal round trips", () => {
  it("returns the exact canonical string that was written", async () => {
    const values = [
      "0",
      "1",
      "0.5",
      "0.000000000000000001",
      "123456789012345678901234567890.123456789",
      "-0.000001",
    ];

    for (const [index, value] of values.entries()) {
      const assetId = `asset-round-trip-${index}`;
      await context.repositories.balances.setActualBalance(
        { accountRef: "round-trip", environment: "PAPER", assetId },
        "COLLATERAL",
        value.startsWith("-") ? "0" : value,
      );

      const balance = await context.repositories.balances.findBalance({
        accountRef: "round-trip",
        environment: "PAPER",
        assetId,
      });

      const expected = value.startsWith("-") ? "0" : value;
      expect(balance?.actualAmount, value).toBe(expected);
      expect(typeof balance?.actualAmount).toBe("string");
    }
  });

  it("keeps a signed ledger amount exactly as written", async () => {
    const id = await context.repositories.ledger.postTransaction({
      eventType: "MANUAL_ADJUSTMENT",
      environment: "PAPER",
      accountRef: "round-trip",
      source: "internal",
      occurredAt: fixtureTimestamp(),
      entries: [
        {
          scope: "ACTUAL_ACCOUNT",
          accountRef: "round-trip",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "-0.000000000000000001",
        },
        {
          scope: "EXTERNAL_CLEARING",
          accountRef: "round-trip",
          assetId: "pUSD",
          assetKind: "COLLATERAL",
          amount: "0.000000000000000001",
        },
      ],
    });

    const stored = await context.repositories.ledger.findTransaction(id);
    expect(stored?.entries.map((entry) => entry.amount)).toEqual([
      "-0.000000000000000001",
      "0.000000000000000001",
    ]);
  });

  it("rejects a price outside the unit interval (§7.3)", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into execution.groups
           (execution_group_id, plan_id, group_ordinal, group_kind, token_id, side, limit_price, shares)
         values ($1, $2, 99, 'SLICE', $3, 'BUY', '1.01', '1')`,
        [uuidV7(), chain.planId, chain.tokenId],
      ),
    );
    expect((error as { code?: string }).code).toBe("23514");
  });

  it("accepts the unit-interval boundaries", async () => {
    for (const [ordinal, price] of [
      [90, "0"],
      [91, "1"],
      [92, "0.999999"],
    ] as const) {
      await context.pool.query(
        `insert into execution.groups
           (execution_group_id, plan_id, group_ordinal, group_kind, token_id, side, limit_price, shares)
         values ($1, $2, $3, 'SLICE', $4, 'BUY', $5, '1')`,
        [uuidV7(), chain.planId, ordinal, chain.tokenId, price],
      );
    }

    const groups = await context.db
      .selectFrom("execution.groups")
      .select(["limit_price"])
      .where("plan_id", "=", chain.planId)
      .where("group_ordinal", ">=", 90)
      .orderBy("group_ordinal", "asc")
      .execute();

    expect(groups.map((group) => group.limit_price)).toEqual(["0", "1", "0.999999"]);
  });
});

describe("timestamps", () => {
  it("returns ISO-8601 UTC instants, not Date objects", async () => {
    const market = await context.repositories.catalog.findMarketByConditionId(
      `condition-repos`,
    );

    expect(typeof market?.created_at).toBe("string");
    expect(market?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/u);
    expect(market?.open_time).toBe(fixtureTimestamp(-3600).replace(".000Z", "Z"));
  });
});

describe("identifiers", () => {
  it("refuses a primary key that is not a sortable UUIDv7 (§10.7)", async () => {
    const notV7 = "00000000-0000-4000-8000-000000000000";
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into catalog.series (series_id, series_key, display_name, underlying_symbol)
         values ($1, 'rejected-series', 'Rejected', 'BTC')`,
        [notV7],
      ),
    );
    expect((error as { code?: string }).code).toBe("23514");
  });

  it("assigns a server-side UUIDv7 when the caller omits the id", async () => {
    const result = await context.pool.query<{ series_id: string }>(
      `insert into catalog.series (series_key, display_name, underlying_symbol)
       values ('server-generated', 'Server generated', 'ETH')
       returning series_id`,
    );
    expect(result.rows[0]?.series_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe("versioned catalog records (§6 invariant 9)", () => {
  it("keeps every historical parameter version readable", async () => {
    const version = await context.repositories.catalog.recordParameterVersion({
      marketId: chain.marketId,
      changedParameters: ["tick_size"],
      parameters: {
        tickSize: "0.001",
        minimumOrderSize: "5",
        tradingDelaySeconds: 0,
        negRisk: false,
        lifecycleState: "OPEN",
      },
      source: "polymarket",
      observedAt: fixtureTimestamp(10),
    });

    expect(version).toBe(2);

    const first = await context.repositories.catalog.findParameterVersion(chain.marketId, 1);
    const second = await context.repositories.catalog.findParameterVersion(chain.marketId, 2);

    expect(first?.tick_size).toBe("0.01");
    expect(second?.tick_size).toBe("0.001");
    expect(second?.previous_parameters_version).toBe(1);
    expect(second?.changed_parameters).toEqual(["tick_size"]);

    const market = await context.repositories.catalog.findMarketByConditionId("condition-repos");
    expect(market?.current_parameters_version).toBe(2);
    expect(market?.tick_size).toBe("0.001");
  });

  it("refuses to rewrite a historical parameter version", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `update catalog.market_parameter_history set tick_size = '0.5' where market_id = $1`,
        [chain.marketId],
      ),
    );
    expect((error as { code?: string }).code).toBe("PMB01");
  });

  it("appends immutable rule versions and repoints the projection", async () => {
    const first = await context.repositories.catalog.recordRuleVersion({
      marketId: chain.marketId,
      rulesText: "Rules v1",
      rulesHash: hashOf("repos-rules-v1"),
      observedAt: fixtureTimestamp(),
    });
    const second = await context.repositories.catalog.recordRuleVersion({
      marketId: chain.marketId,
      rulesText: "Rules v2 with a clarification",
      rulesHash: hashOf("repos-rules-v2"),
      observedAt: fixtureTimestamp(20),
    });

    expect(first).not.toBe(second);

    const versions = await context.db
      .selectFrom("catalog.market_rule_versions")
      .selectAll()
      .where("market_id", "=", chain.marketId)
      .orderBy("rules_version", "asc")
      .execute();

    expect(versions.map((version) => version.rules_version)).toEqual([1, 2]);

    const market = await context.repositories.catalog.findMarketByConditionId("condition-repos");
    expect(market?.current_rule_version_id).toBe(second);

    const error = await captureRejection(async () =>
      context.db
        .updateTable("catalog.market_rule_versions" as never)
        .set({ rules_text: "edited" } as never)
        .execute(),
    );
    const { mapPostgresError } = await import("@polymarket-bot/storage-postgres");
    expect(mapPostgresError(error)).toBeInstanceOf(AppendOnlyViolationError);
  });
});

describe("settlement specs (§9.3)", () => {
  it("refuses a terminal-spot payoff model on a TWAP-settled series", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `insert into catalog.settlement_specs
           (settlement_spec_id, series_id, spec_version, resolution_source, reference_symbol,
            observation_type, window_seconds, payoff_model)
         values ($1, $2, 1, 'Chainlink TWAP', 'BTCUSD', 'TWAP', 60, 'TerminalSpotBinaryModel')`,
        [uuidV7(), chain.seriesId],
      ),
    );
    expect((error as { code?: string }).code).toBe("23514");
    expect((error as { constraint?: string }).constraint).toBe(
      "settlement_specs_model_matches_observation",
    );
  });

  it("accepts the matching TWAP model", async () => {
    await context.pool.query(
      `insert into catalog.settlement_specs
         (settlement_spec_id, series_id, spec_version, resolution_source, reference_symbol,
          observation_type, window_seconds, payoff_model)
       values ($1, $2, 1, 'Chainlink TWAP', 'BTCUSD', 'TWAP', 60, 'TwapBinaryModel')`,
      [uuidV7(), chain.seriesId],
    );

    const spec = await context.db
      .selectFrom("catalog.settlement_specs")
      .selectAll()
      .where("series_id", "=", chain.seriesId)
      .executeTakeFirst();

    expect(spec?.payoff_model).toBe("TwapBinaryModel");
    expect(spec?.verification_status).toBe("UNVERIFIED");
  });

  it("refuses a verified spec with no verifier recorded", async () => {
    const error = await captureRejection(async () =>
      context.pool.query(
        `update catalog.settlement_specs set verification_status = 'VERIFIED' where series_id = $1`,
        [chain.seriesId],
      ),
    );
    expect((error as { code?: string }).code).toBe("23514");
  });
});
