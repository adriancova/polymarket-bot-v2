/**
 * `UNIV-4` acceptance (c) — the first run in the repository that opens a
 * market from a VENUE-SHAPED response, end to end through real
 * infrastructure (closeout blocker B10, the consumer half).
 *
 * ## What runs
 *
 * - The REAL gateway composition (`DataGateway.create`) on its injected
 *   doubles for clock, timers, ids, WAL filesystem and sockets — and the REAL
 *   `RedisStreamsEventTransport` (Testcontainers Redis) as its publisher. Its
 *   market lifecycle feed polls a stub of the documented `GET /markets/{id}`
 *   surface (D-30) answering a trade-ready `Market`, derives the REAL
 *   `MarketOpened`, journals the raw response first, and publishes it through
 *   the gateway's own dispatcher, sequencer and publisher onto the Redis
 *   stream; its market WebSocket driver normalizes two `book` frames into the
 *   `BookSnapshot`s on the same stream; its Binance driver publishes the two
 *   reference trades the risk engine's freshness check reads.
 * - The REAL trader composition root (`assembleDurableTrader`, the process's
 *   own steps 3b/4) against a Testcontainers PostgreSQL, registered through
 *   the `WP-040` repositories exactly as `BOOT-1` does, consuming that stream
 *   through the process's own `RedisMarketEventFeed` and `pump`.
 *
 * ## What is proven
 *
 * The trader's market leaves `PENDING` on an event NOTHING in this file
 * wrote — the only `MarketOpened` in the stream carries the gateway's own
 * epoch, `source: "polymarket"`, `sourceChannel: "polymarket:gamma-market-rest"`
 * and a `causationId` naming the journaled Gamma response — and the Static
 * Bracket's entry is ADMITTED on the gateway's book: a risk approval, a plan,
 * a submission, a fill, and a `strategy.decisions` row in PostgreSQL. The
 * contrast scenario runs the same gateway WITHOUT the lifecycle feed: the
 * trader stays `PENDING` (§9.8 `UNKNOWN`, fail closed) and admits nothing.
 *
 * ## Docker
 *
 * Testcontainers, as `durable-trader-first-fill-postgres.test.ts` and the
 * event-bus suite: this file's own `beforeAll` starts one PostgreSQL and one
 * Redis; no `globalSetup`; no skip when Docker is absent. Throwaway
 * credentials; `environment` is `PAPER` throughout; no venue, no signer, no
 * real order; the Gamma "server" is the gateway's injected HTTP port.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import { DataGateway, parseGatewayConfig } from "@polymarket-bot/data-gateway";
import {
  deterministicIdSource,
  ManualGatewayClock,
  ManualGatewayTimers,
} from "@polymarket-bot/data-gateway/testing";
import { RedisStreamsEventTransport } from "@polymarket-bot/event-bus";
import { startRedisContainer, uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { parseTraderConfig, type IngestedEvent, type MarketEventFeed } from "@polymarket-bot/trader";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisMarketEventFeed } from "../../../apps/trader/src/adapters/redis-feed.js";
import { assembleDurableTrader, SystemPaperClock } from "../../../apps/trader/src/main.js";
import { pump } from "../../../apps/trader/src/pump.js";
import {
  ScriptedBinanceSocketFactory,
  ScriptedPublicSocketFactory,
} from "../data-gateway/support/scripted-sockets.js";
import { NO_TOKEN, T_CLOSE, T_OPEN, YES_TOKEN, safeEnvironment } from "./support/fixture.js";
import {
  CONDITION_ID,
  documentFor,
  registerThroughTheRepositories,
  withFreshDatabase,
  type Registered,
} from "./support/registration.js";

let postgres: Awaited<ReturnType<typeof startPostgresContainer>>;
let redis: Awaited<ReturnType<typeof startRedisContainer>>;

beforeAll(async () => {
  [postgres, redis] = await Promise.all([startPostgresContainer(), startRedisContainer()]);
}, 300_000);

afterAll(async () => {
  await Promise.all([postgres?.stop(), redis?.stop()]);
});

const GAMMA_BASE = "http://gamma.stub";
const GAMMA_MARKET_ID = "900001";

/** A trade-ready `Market` in the documented D-30 shape. */
function readyMarket(conditionId: string): Record<string, unknown> {
  return {
    conditionId,
    question: "Synthetic market (stub)",
    active: true,
    closed: false,
    archived: false,
    acceptingOrders: true,
    restricted: false,
    enableOrderBook: true,
    negRisk: false,
    startDate: "2026-03-04T12:00:00Z",
    endDate: "2026-03-04T12:15:00Z",
    closedTime: null,
    gameStartTime: null,
  };
}

/** A market-WS `book` frame; the YES ladder is the fixture's (executable buy for 50 @ 0.34). */
function bookFrame(
  conditionId: string,
  tokenId: string,
  bids: readonly [string, string][],
  asks: readonly [string, string][],
): string {
  return JSON.stringify([
    {
      event_type: "book",
      market: conditionId,
      asset_id: tokenId,
      bids: bids.map(([price, size]) => ({ price, size })),
      asks: asks.map(([price, size]) => ({ price, size })),
      hash: `hash-${tokenId}`,
      timestamp: String(Date.parse(T_OPEN)),
    },
  ]);
}

function binanceTradeFrame(tradeId: number, atMs: number, price: string): string {
  return JSON.stringify({
    stream: "btcusdt@trade",
    data: { e: "trade", E: atMs, s: "BTCUSDT", t: tradeId, p: price, q: "0.5", T: atMs, m: false },
  });
}

/**
 * Runs the real gateway against the real Redis for one scenario and leaves it
 * RUNNING (so no `FeedDisconnected` precedes the trader's read). The caller
 * stops it.
 */
async function runGateway(options: {
  readonly registered: Registered;
  readonly conditionId: string;
  readonly stream: string;
  readonly lifecycle: boolean;
}): Promise<{ readonly gateway: DataGateway; readonly gammaRequests: readonly string[] }> {
  const gammaRequests: string[] = [];
  const config = parseGatewayConfig({
    streamName: options.stream,
    wal: { rootPath: "/wal" },
    markets: [
      {
        internalMarketId: options.registered.marketId,
        conditionId: options.conditionId,
        yesTokenId: YES_TOKEN,
        noTokenId: NO_TOKEN,
        gammaMarketId: GAMMA_MARKET_ID,
        parameters: {
          tickSize: "0.01",
          minimumOrderSize: "5",
          negRisk: false,
          tradingDelaySeconds: 0,
          status: "OPEN",
          openTime: T_OPEN,
          closeTime: T_CLOSE,
        },
        observedAt: "2026-03-04T11:00:00.000Z",
      },
    ],
    polymarket: { feedId: "polymarket-market" },
    binance: { feedId: "binance-reference", symbols: ["BTCUSDT"], stalenessThresholdMs: 30_000 },
    ...(options.lifecycle
      ? { lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 } }
      : {}),
  });

  const clock = new ManualGatewayClock();
  const timers = new ManualGatewayTimers(clock);
  const polymarketSockets = new ScriptedPublicSocketFactory();
  const binanceSockets = new ScriptedBinanceSocketFactory();
  const route = (request: PublicHttpRequest): PublicHttpResponse => {
    if (request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
      gammaRequests.push(request.url);
      return { status: 200, body: JSON.stringify(readyMarket(options.conditionId)) };
    }
    throw new Error(`unexpected HTTP request in this scenario: ${request.url}`);
  };
  // The REAL transport, as `runGatewaySequence` connects it in `main.ts`.
  const transport = await RedisStreamsEventTransport.connect({
    connection: { url: redis.getConnectionUrl() },
    retention: { maxEvents: 10_000 },
  });
  const gateway = await DataGateway.create(config, {
    clock,
    ids: deterministicIdSource(11),
    timers,
    walFileSystem: createMemoryFileSystem(),
    transport,
    polymarketSocketFactory: polymarketSockets.factory,
    polymarketHttpClient: async (request) => route(request),
    binanceSocketFactory: binanceSockets.factory,
  });
  // The gateway's manual clock starts in 2025; the fixture opens at T_OPEN.
  timers.advance(Date.parse(T_OPEN) - clock.nowMs());
  gateway.start();
  const binance = binanceSockets.current;
  binance.open();
  binance.message(binanceTradeFrame(1, clock.nowMs(), "100000"));
  binance.message(binanceTradeFrame(2, clock.nowMs(), "100100"));
  // The first lifecycle poll (at start) is in flight: let it journal, derive
  // and publish before the books arrive.
  await gateway.settle();
  const socket = polymarketSockets.current;
  socket.open();
  socket.message(
    bookFrame(options.conditionId, YES_TOKEN, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]]),
  );
  socket.message(bookFrame(options.conditionId, NO_TOKEN, [["0.65", "200"]], [["0.66", "200"]]));
  await gateway.settle();
  return { gateway, gammaRequests };
}

/** Records what the process's own feed delivered, so the source can be asserted. */
function recording(feed: RedisMarketEventFeed): {
  readonly feed: MarketEventFeed;
  readonly delivered: IngestedEvent[];
} {
  const delivered: IngestedEvent[] = [];
  return {
    delivered,
    feed: {
      poll: async () => {
        const result = await feed.poll();
        if (result.ok) delivered.push(...result.value);
        return result;
      },
      commit: () => feed.commit(),
      close: () => feed.close(),
    },
  };
}

describe("UNIV-4 acceptance (c) — the trader opens a market from the gateway's REAL MarketOpened, over Redis", () => {
  it("leaves PENDING on the gateway-produced MarketOpened and admits an entry on the gateway-produced book", async () => {
    await withFreshDatabase(postgres.getConnectionUri(), "univ4-open", async ({ connectionString, context }) => {
      const label = "univ4-open";
      const registered = await registerThroughTheRepositories(context, label);
      const conditionId = `${CONDITION_ID}-${label}`;
      const stream = uniqueStreamName("univ4-open");

      const { gateway, gammaRequests } = await runGateway({ registered, conditionId, stream, lifecycle: true });
      expect(gammaRequests).toEqual([`${GAMMA_BASE}/markets/${GAMMA_MARKET_ID}`]);
      expect(gateway.metrics().lifecycle).toMatchObject({
        polls: 1,
        framesRecorded: 1,
        marketOpenedEmitted: 1,
        marketClosingScheduledEmitted: 0,
      });

      // The REAL composition root against the registered database.
      const base = documentFor(registered, label);
      const document = {
        ...base,
        infrastructure: { ...(base["infrastructure"] as Record<string, unknown>), eventStream: stream },
      };
      const parsed = parseTraderConfig(document);
      if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
      const lines: string[] = [];
      const assembled = await assembleDurableTrader({
        env: safeEnvironment(),
        config: parsed.config,
        document,
        postgresUrl: connectionString,
        clock: new SystemPaperClock(),
        log: (line) => {
          lines.push(line);
        },
      });
      expect(assembled.ok ? "ok" : lines.join("\n")).toBe("ok");
      if (!assembled.ok) throw new Error("unreachable");
      const { trader, store } = assembled;

      // The process's own feed over the process's own transport binding.
      const traderTransport = await RedisStreamsEventTransport.connect({
        connection: { url: redis.getConnectionUrl() },
        retention: { maxEvents: parsed.config.infrastructure.retentionMaxEvents },
      });
      const subscription = await traderTransport.subscribe({
        stream: parsed.config.infrastructure.eventStream,
        consumerId: parsed.config.infrastructure.consumerId,
      });
      const redisFeed = new RedisMarketEventFeed({
        subscription,
        maxEvents: parsed.config.infrastructure.receiveBatchSize,
      });
      const { feed, delivered } = recording(redisFeed);
      try {
        expect(trader.markets.get(registered.marketId)?.lifecycle).toBe("PENDING");
        const result = await pump({ loop: trader.loop, feed, halts: trader.halts, maxPolls: 50, untilIdle: true });
        expect(result.stopped).toBe("IDLE");
        expect(result.ingested).toBeGreaterThanOrEqual(5);

        // Every event the trader consumed came from THIS gateway epoch; the
        // one MarketOpened is the lifecycle feed's, from the venue-shaped stub.
        const envelopes = delivered.map((event) => event.envelope as EventEnvelope<unknown>);
        for (const envelope of envelopes) expect(envelope.gatewayEpoch).toBe(gateway.gatewayEpoch);
        const opened = envelopes.filter((envelope) => envelope.eventType === "MarketOpened");
        expect(opened).toHaveLength(1);
        expect(opened[0]?.source).toBe("polymarket");
        expect(opened[0]?.sourceChannel).toBe("polymarket:gamma-market-rest");
        expect(opened[0]?.causationId).toMatch(new RegExp(`^raw:${gateway.gatewayEpoch}:\\d+$`, "u"));
        expect(opened[0]?.payload).toEqual({
          internalMarketId: registered.marketId,
          conditionId,
          openedAt: T_OPEN,
        });
        expect(envelopes.filter((envelope) => envelope.eventType === "MarketClosing")).toHaveLength(0);
        expect(envelopes.filter((envelope) => envelope.eventType === "BookSnapshot")).toHaveLength(2);

        // The market left PENDING, and the entry was admitted end to end.
        const health = trader.loop.health();
        expect(health.halts).toEqual([]);
        expect(trader.markets.get(registered.marketId)?.lifecycle).toBe("OPEN");
        expect(health.risk.approvals).toBeGreaterThanOrEqual(1);
        expect(health.execution.plansBuilt).toBeGreaterThanOrEqual(1);
        expect(health.execution.submissionsAccepted).toBeGreaterThanOrEqual(1);
        expect(health.execution.fillsObserved).toBeGreaterThanOrEqual(1);
        const entry = trader.loop.decisions().find((decision) => decision.decisionType === "enter");
        expect(entry).toBeDefined();
        // …and durably: the decision landed in PostgreSQL under the registered run.
        const decisions = await context.db
          .selectFrom("strategy.decisions")
          .select(["run_id", "source_event_id"])
          .execute();
        expect(decisions.length).toBeGreaterThanOrEqual(1);
        for (const row of decisions) expect(row.run_id).toBe(registered.runId);
        expect(decisions.some((row) => row.source_event_id === entry?.sourceEventId)).toBe(true);
      } finally {
        await feed.close();
        await store.close();
        await traderTransport.close();
        await gateway.stop();
      }
    });
  }, 180_000);

  it("without the lifecycle feed the same gateway stream leaves the trader PENDING and admits nothing (the pin, for contrast)", async () => {
    await withFreshDatabase(postgres.getConnectionUri(), "univ4-pending", async ({ connectionString, context }) => {
      const label = "univ4-pending";
      const registered = await registerThroughTheRepositories(context, label);
      const conditionId = `${CONDITION_ID}-${label}`;
      const stream = uniqueStreamName("univ4-pending");

      const { gateway, gammaRequests } = await runGateway({ registered, conditionId, stream, lifecycle: false });
      expect(gammaRequests).toEqual([]);
      expect(gateway.metrics().lifecycle).toBeUndefined();

      const base = documentFor(registered, label);
      const document = {
        ...base,
        infrastructure: { ...(base["infrastructure"] as Record<string, unknown>), eventStream: stream },
      };
      const parsed = parseTraderConfig(document);
      if (!parsed.ok) throw new Error(`${parsed.refusal.code}: ${parsed.refusal.issues.join("; ")}`);
      const assembled = await assembleDurableTrader({
        env: safeEnvironment(),
        config: parsed.config,
        document,
        postgresUrl: connectionString,
        clock: new SystemPaperClock(),
        log: () => undefined,
      });
      if (!assembled.ok) throw new Error("the trader did not assemble");
      const { trader, store } = assembled;
      const traderTransport = await RedisStreamsEventTransport.connect({
        connection: { url: redis.getConnectionUrl() },
        retention: { maxEvents: parsed.config.infrastructure.retentionMaxEvents },
      });
      const subscription = await traderTransport.subscribe({
        stream: parsed.config.infrastructure.eventStream,
        consumerId: parsed.config.infrastructure.consumerId,
      });
      const { feed, delivered } = recording(
        new RedisMarketEventFeed({ subscription, maxEvents: parsed.config.infrastructure.receiveBatchSize }),
      );
      try {
        const result = await pump({ loop: trader.loop, feed, halts: trader.halts, maxPolls: 50, untilIdle: true });
        expect(result.stopped).toBe("IDLE");
        const types = delivered.map((event) => event.envelope.eventType);
        expect(types).toContain("BookSnapshot");
        expect(types).not.toContain("MarketOpened");
        const health = trader.loop.health();
        expect(trader.markets.get(registered.marketId)?.lifecycle).toBe("PENDING");
        expect(health.risk.approvals).toBe(0);
        expect(health.execution.plansBuilt).toBe(0);
        expect(health.execution.submissionsAccepted).toBe(0);
        expect(health.execution.fillsObserved).toBe(0);
      } finally {
        await feed.close();
        await store.close();
        await traderTransport.close();
        await gateway.stop();
      }
    });
  }, 180_000);
});
