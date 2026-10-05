/**
 * The integration harness: a whole gateway on injected doubles.
 *
 * Everything the process would own in production is replaced at its port:
 * manual clock and timers, deterministic ids, the WP-050 in-memory
 * filesystem, the in-memory WP-060 transport with failure injection, and
 * scripted sockets on every adapter's own transport port. `pnpm` runs this
 * offline; nothing here can reach a network.
 */

import type { EventEnvelope } from "@polymarket-bot/domain";
import { FakeCoinbaseSocketFactory } from "@polymarket-bot/coinbase-adapter/testing";
import type { GatewayConfig, GatewayObserver } from "@polymarket-bot/data-gateway";
import {
  DataGateway,
  parseGatewayConfig,
  UnavailableEventTransport,
} from "@polymarket-bot/data-gateway";
import {
  deterministicIdSource,
  ManualGatewayClock,
  ManualGatewayTimers,
  MemoryEventTransport,
} from "@polymarket-bot/data-gateway/testing";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { createMemoryFileSystem, type MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";

import { ScriptedBinanceSocketFactory, ScriptedPublicSocketFactory } from "./scripted-sockets.js";

export const STREAM = "market-events";

export const MARKET = {
  internalMarketId: "01990000-0000-7000-8000-000000000001",
  conditionId: "0x" + "ab".repeat(31),
  yesTokenId: "11111",
  noTokenId: "22222",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
  },
  observedAt: "2026-08-30T12:00:00.000Z",
} as const;

export interface RecordedIncident {
  readonly incidentId: string;
  readonly reasonCode: string;
  readonly severity: string;
  readonly detail: string;
  readonly feedId?: string | undefined;
}

export interface Harness {
  readonly gateway: DataGateway;
  readonly config: GatewayConfig;
  readonly clock: ManualGatewayClock;
  readonly timers: ManualGatewayTimers;
  /**
   * Lifetime-anchor accounting (round-2 review R2-H5): the counting fake
   * behind the gateway's `lifetime` port. In production the handle is a
   * REFERENCED interval that holds the process alive; here it is only
   * counted, so no test can hang on it. `start()` must acquire exactly once
   * and `stop()` must release exactly once.
   */
  readonly lifetime: { acquired: number; released: number };
  readonly transport: MemoryEventTransport;
  readonly walFileSystem: MemoryFileSystem;
  readonly polymarketSockets: ScriptedPublicSocketFactory;
  readonly rtdsSockets: ScriptedPublicSocketFactory;
  readonly binanceSockets: ScriptedBinanceSocketFactory;
  readonly coinbaseSockets: FakeCoinbaseSocketFactory;
  readonly incidents: RecordedIncident[];
  readonly halts: string[];
  readonly recordingFailures: string[];
  published(): readonly EventEnvelope<unknown>[];
  publishedOfType(eventType: string): readonly EventEnvelope<unknown>[];
  /** Everything published, then drained: awaits publisher + WAL settling. */
  settle(): Promise<void>;
}

export interface HarnessOptions {
  /**
   * Raw configuration INPUT, merged over the defaults below and validated by
   * `parseGatewayConfig`.
   *
   * Deliberately typed as a plain record rather than `Partial<GatewayConfig>`:
   * `GatewayConfig` is the schema's OUTPUT (defaults already applied), so a
   * test written against it would have to restate every defaulted field.
   * Validation is what checks these values, and it is real.
   */
  readonly config?: Record<string, unknown>;
  /** Routes the snapshot fetcher's HTTP reads. Defaults to "throw". */
  readonly http?: (request: PublicHttpRequest) => PublicHttpResponse | Promise<PublicHttpResponse>;
  readonly observer?: GatewayObserver;
  /**
   * Models a process that STARTED while the event bus was unreachable
   * (§4.2, round-1 review H5).
   *
   * The gateway is built on `UnavailableEventTransport` and immediately put
   * into the terminal publication halt, which is exactly the sequence
   * `main.ts` runs. `published()` therefore reads an untouched
   * `MemoryEventTransport` and is empty by construction — the point of the
   * test is that the WAL is not.
   */
  readonly startupTransportFailure?: string;
  /**
   * Distinguishes one modelled process lifetime from another.
   *
   * A test that models a RESTART passes a different seed, so the second
   * gateway mints a different `gatewayEpoch` exactly as a real restart does.
   */
  readonly idSeed?: number;
  /** Share a WAL filesystem across two harnesses, to model a restart on disk. */
  readonly walFileSystem?: MemoryFileSystem;
  /**
   * `ROLLOVER-1`: the process run mode the gateway is handed (`GatewayPorts.runMode`).
   * Defaults to `PAPER`; the series-admission feed refuses any other but
   * `BACKTEST`. `null` hands it no run mode at all.
   */
  readonly runMode?: string | null;
  /** `ROLLOVER-1`: the manual clock's start (epoch ms); defaults to the clock's own. */
  readonly clockStartMs?: number;
}

export async function buildHarness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = new ManualGatewayClock(options.clockStartMs);
  const timers = new ManualGatewayTimers(clock);
  const transport = new MemoryEventTransport();
  const walFileSystem = options.walFileSystem ?? createMemoryFileSystem();
  const polymarketSockets = new ScriptedPublicSocketFactory();
  const rtdsSockets = new ScriptedPublicSocketFactory();
  const binanceSockets = new ScriptedBinanceSocketFactory();
  const coinbaseSockets = new FakeCoinbaseSocketFactory();

  const incidents: RecordedIncident[] = [];
  const halts: string[] = [];
  const recordingFailures: string[] = [];
  const lifetime = { acquired: 0, released: 0 };

  const config = parseGatewayConfig({
    streamName: STREAM,
    wal: { rootPath: "/wal" },
    markets: [MARKET],
    ...options.config,
  });

  const httpRoute =
    options.http ??
    ((): PublicHttpResponse => {
      throw new Error("no HTTP route configured for this test");
    });

  const gatewayTransport =
    options.startupTransportFailure === undefined
      ? transport
      : new UnavailableEventTransport(options.startupTransportFailure);

  const gateway = await DataGateway.create(config, {
    clock,
    ids: deterministicIdSource(options.idSeed ?? 0),
    timers,
    lifetime: {
      acquire: () => {
        lifetime.acquired += 1;
        return () => {
          lifetime.released += 1;
        };
      },
    },
    walFileSystem,
    transport: gatewayTransport,
    polymarketSocketFactory: polymarketSockets.factory,
    polymarketHttpClient: async (request) => httpRoute(request),
    rtdsSocketFactory: rtdsSockets.factory,
    binanceSocketFactory: binanceSockets.factory,
    coinbaseSocketFactory: coinbaseSockets,
    ...(options.runMode === null ? {} : { runMode: options.runMode ?? "PAPER" }),
    observer: {
      onIncident: (incident) => {
        incidents.push(incident);
        options.observer?.onIncident?.(incident);
      },
      onPublicationHalted: (halt) => {
        halts.push(halt.cause);
        options.observer?.onPublicationHalted?.(halt);
      },
      onRecordingFailure: (failure) => {
        recordingFailures.push(failure.reason);
        options.observer?.onRecordingFailure?.(failure);
      },
      ...(options.observer?.onEnvelopeRejected === undefined
        ? {}
        : { onEnvelopeRejected: options.observer.onEnvelopeRejected.bind(options.observer) }),
    },
  });

  if (options.startupTransportFailure !== undefined) {
    // Exactly what `main.ts` does after a failed startup connection: the same
    // terminal halt and the same PAGE incident a mid-run outage produces,
    // BEFORE any feed starts — and the WAL is already open.
    gateway.haltPublication("EVENT_BUS_UNAVAILABLE", options.startupTransportFailure);
  }

  return {
    gateway,
    config,
    clock,
    timers,
    lifetime,
    transport,
    walFileSystem,
    polymarketSockets,
    rtdsSockets,
    binanceSockets,
    coinbaseSockets,
    incidents,
    halts,
    recordingFailures,
    published: () => transport.published(STREAM),
    publishedOfType: (eventType) =>
      transport.published(STREAM).filter((envelope) => envelope.eventType === eventType),
    settle: async () => {
      await gateway.settle();
    },
  };
}

// ---------------------------------------------------------------------------
// Wire-frame builders (documented venue shapes; see the adapters' venue notes)
// ---------------------------------------------------------------------------

/** A Polymarket market-WS `book` snapshot frame for one token. */
export function polymarketBookFrame(tokenId: string, conditionId: string): string {
  return JSON.stringify([
    {
      event_type: "book",
      market: conditionId,
      asset_id: tokenId,
      bids: [{ price: "0.45", size: "100" }],
      asks: [{ price: "0.55", size: "80" }],
      hash: "bookhash-1",
      timestamp: "1772400000000",
    },
  ]);
}

/** A `GET/POST /book(s)` REST body for the snapshot fetcher. */
export function polymarketRestBook(tokenId: string, conditionId: string): unknown {
  return {
    market: conditionId,
    asset_id: tokenId,
    timestamp: "1772400001000",
    hash: "resthash-1",
    bids: [{ price: "0.44", size: "90" }],
    asks: [{ price: "0.56", size: "70" }],
    min_order_size: "5",
    tick_size: "0.01",
    neg_risk: false,
  };
}

/** A Binance combined-stream trade frame. */
export function binanceTradeFrame(symbol: string, tradeId: number, atMs: number): string {
  return JSON.stringify({
    stream: `${symbol.toLowerCase()}@trade`,
    data: {
      e: "trade",
      E: atMs,
      s: symbol.toUpperCase(),
      t: tradeId,
      p: "50000.10",
      q: "0.50",
      T: atMs,
      m: false,
    },
  });
}

/** An RTDS TWAP update frame. */
export function rtdsUpdateFrame(options: {
  readonly symbol: string;
  readonly observationMs: number;
  readonly windowSeconds?: 30 | 60;
  readonly publisherMs?: number;
  readonly valueE18?: string;
}): string {
  const windowSeconds = options.windowSeconds ?? 60;
  return JSON.stringify({
    topic: windowSeconds === 30 ? "crypto_prices_twap_thirty" : "crypto_prices_twap_sixty",
    type: "update",
    timestamp: options.publisherMs ?? options.observationMs,
    payload: {
      symbol: options.symbol,
      value: 65000.5,
      full_accuracy_value: options.valueE18 ?? "65000500000000000000000",
      timestamp: options.observationMs,
      window_s: windowSeconds,
    },
  });
}

/** A Coinbase `market_trades` snapshot frame. */
export function coinbaseTradesSnapshot(options: {
  readonly productId: string;
  readonly sequenceNum: number;
  readonly atIso: string;
  readonly tradeId?: string;
  readonly price?: string;
}): string {
  return JSON.stringify({
    channel: "market_trades",
    timestamp: options.atIso,
    sequence_num: options.sequenceNum,
    events: [
      {
        type: "snapshot",
        trades: [
          {
            trade_id: options.tradeId ?? "t-1",
            product_id: options.productId,
            price: options.price ?? "50000.10",
            size: "0.25",
            side: "BUY",
            time: options.atIso,
          },
        ],
      },
    ],
  });
}

/** A Coinbase `ticker` snapshot frame. */
export function coinbaseTickerSnapshot(options: {
  readonly productId: string;
  readonly sequenceNum: number;
  readonly atIso: string;
}): string {
  return JSON.stringify({
    channel: "ticker",
    timestamp: options.atIso,
    sequence_num: options.sequenceNum,
    events: [
      {
        type: "snapshot",
        tickers: [
          {
            type: "ticker",
            product_id: options.productId,
            price: "50000.10",
            best_bid: "50000.00",
            best_bid_quantity: "1.5",
            best_ask: "50000.20",
            best_ask_quantity: "2.0",
          },
        ],
      },
    ],
  });
}
