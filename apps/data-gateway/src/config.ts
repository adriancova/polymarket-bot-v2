/**
 * Gateway configuration (WP-120).
 *
 * Validated with Zod at startup, failing loudly on a defect rather than
 * misbehaving an hour later — the same discipline every adapter applies to its
 * own options.
 *
 * ## No credential surface, by construction
 *
 * The gateway consumes PUBLIC, unauthenticated market data only (§0.2,
 * ADR-010). This schema is STRICT at every level, so a key resembling an API
 * key, signer, wallet, token, or password cannot even be represented — an
 * unknown key is a validation error. There is no field anywhere in this app
 * that could carry authentication material.
 *
 * ## The stream name is stable across restarts
 *
 * Durable consumer checkpoints, resync state, and lag metrics on the WP-060
 * transport are keyed by `(stream, consumerId)`. A stream name that embedded
 * the gateway epoch or any per-boot value would orphan every consumer
 * checkpoint on every restart, turning ordinary restarts into hard resyncs.
 * The name therefore comes only from configuration, and the schema refuses
 * shapes that look time- or boot-derived (see `STREAM_NAME_PATTERN`).
 */

import { DEFAULT_FSYNC_INTERVAL_MS } from "@polymarket-bot/storage-wal";
import { z } from "zod";

import { GatewayConfigurationError } from "./errors.js";
import {
  DEFAULT_PUBLISH_QUEUE_MAX_BYTES,
  DEFAULT_PUBLISH_QUEUE_MAX_DEPTH,
} from "./publisher.js";

/** Matches the transport's own stream-name discipline: a bounded code string. */
const CODE_STRING = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;

const FeedIdSchema = z
  .string()
  .regex(CODE_STRING, "feed ids must be bounded CodeString values");

/** Lowercase canonical UUID (any RFC 9562 version). */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * One market the gateway records, from reviewed configuration.
 *
 * §9.2: "Series binding is configuration, not heuristic-only … a new market
 * pattern is not auto-approved." The gateway's universe directory is seeded
 * from exactly this list; a market announced on the wire but absent here is
 * observed and reported, never silently adopted (see `directory.ts`).
 */
export const MarketConfigSchema = z.strictObject({
  /** UUIDv7 minted by the Universe Service's configuration review. */
  internalMarketId: z.string().min(1).max(200),
  conditionId: z.string().min(1).max(200),
  yesTokenId: z.string().min(1).max(200),
  noTokenId: z.string().min(1).max(200),
  seriesId: z.string().min(1).max(200).optional(),
  /** The first parameter version (§9.2's stored set), from the same review. */
  parameters: z.strictObject({
    tickSize: z.string().min(1),
    minimumOrderSize: z.string().min(1),
    negRisk: z.boolean(),
    tradingDelaySeconds: z.number().int().nonnegative(),
    /** §10.1 `market_parameter_history.status`, in WP-110's lifecycle vocabulary. */
    status: z.enum(["DISCOVERED", "OPEN", "CLOSING", "CLOSED", "RESOLVED"]),
    feeScheduleRef: z.string().min(1).optional(),
    openTime: z.string().min(1).optional(),
    closeTime: z.string().min(1).optional(),
  }),
  observedAt: z.string().min(1),
});
export type MarketConfig = z.infer<typeof MarketConfigSchema>;

export const WalConfigSchema = z.strictObject({
  rootPath: z.string().min(1),
  queueCapacity: z.number().int().positive().optional(),
  queueMaxBytes: z.number().int().positive().optional(),
  maxSegmentBytes: z.number().int().positive().optional(),
  maxSegmentAgeMs: z.number().int().positive().optional(),
  fsyncIntervalMs: z.number().int().positive().optional(),
  fsyncByteThreshold: z.number().int().positive().optional(),
  /** §4.2 hard capacity threshold. `null` disables it. */
  maxTotalBytes: z.number().int().positive().nullable().optional(),
});

export const PolymarketFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default("polymarket-market"),
  url: z.string().min(1).optional(),
  customFeatureEnabled: z.boolean().optional(),
  maximumAssetsPerSubscriptionFrame: z.number().int().positive().optional(),
  heartbeatIntervalMs: z.number().int().positive().optional(),
  pongTimeoutMs: z.number().int().positive().optional(),
  stalenessCheckIntervalMs: z.number().int().positive().optional(),
  snapshotBaseUrl: z.string().min(1).optional(),
});

export const RtdsFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default("polymarket-rtds-twap"),
  url: z.string().min(1).optional(),
  subscriptions: z
    .array(
      z.strictObject({
        windowSeconds: z.union([z.literal(30), z.literal(60)]),
        symbols: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1),
  /**
   * Symbols the gateway PUBLISHES, lowercase (`btc/usd`).
   *
   * A multi-symbol RTDS subscription receives every symbol (the venue's own
   * rule); per WP-100's consumer obligations the gateway filters on
   * `payload.symbol`. An update outside this set is counted, never silently
   * dropped, and never published.
   */
  plannedSymbols: z.array(z.string().min(1)).min(1),
  updateStalenessMs: z.number().int().positive().optional(),
  stalenessCheckIntervalMs: z.number().int().positive().optional(),
  /**
   * Freshness bound on the Chainlink observation time, in milliseconds.
   *
   * An observation whose window end is older than this at receipt FAILS
   * freshness and opens an incident. A seconds-spelled venue timestamp
   * produces a visibly-wrong 1970 window (WP-100 round-1 known risk 1), which
   * this bound is required to fail.
   */
  maxObservationAgeMs: z.number().int().positive().default(300_000),
});

export const BinanceFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default("binance-reference"),
  symbols: z.array(z.string().min(1)).min(1),
  /** REQUIRED by the adapter: Binance documents no message cadence. */
  stalenessThresholdMs: z.number().int().positive(),
  stalenessCheckIntervalMs: z.number().int().positive().default(5_000),
  endpoint: z.string().min(1).optional(),
  reconnect: z
    .strictObject({
      initialDelayMs: z.number().int().nonnegative(),
      maxDelayMs: z.number().int().positive(),
      multiplier: z.number().min(1),
      maxAttempts: z.number().int().positive().optional(),
    })
    .optional(),
  /** Unauthorized-event escalation threshold (WP-080 round-2 follow-up 2). */
  unauthorizedEventEscalationThreshold: z.number().int().positive().default(3),
});

export const CoinbaseFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default("coinbase-reference"),
  productIds: z.array(z.string().min(1)).min(1),
  stalenessThresholdMs: z.number().int().positive().optional(),
  stalenessPollIntervalMs: z.number().int().positive().optional(),
  endpoint: z.string().min(1).optional(),
  /**
   * Escalation threshold for the persistent-snapshot-failure reconnect loop
   * (WP-090 known risk 1 / round-2 follow-up 2): after this many
   * `COINBASE_SNAPSHOT_NOT_APPLIED` anomalies on one channel without an
   * intervening applied snapshot, the gateway opens a PAGE incident.
   */
  snapshotFailureEscalationThreshold: z.number().int().positive().default(3),
  /** Same escalation for consecutive failed connection attempts. */
  reconnectLoopEscalationThreshold: z.number().int().positive().default(5),
});

/**
 * Bounds on the publisher's admission queue (§8.3: every queue is bounded).
 *
 * Safety parameters, not throughput knobs. Raising either one buys tolerance
 * for a longer transport stall and costs memory plus a longer window of events
 * that exist only in the WAL; crossing either one is a terminal publication
 * halt with a PAGE incident, never a drop.
 */
export const PublisherConfigSchema = z.strictObject({
  maxQueueDepth: z.number().int().positive().default(DEFAULT_PUBLISH_QUEUE_MAX_DEPTH),
  maxQueueBytes: z.number().int().positive().default(DEFAULT_PUBLISH_QUEUE_MAX_BYTES),
});

export const GatewayConfigSchema = z.strictObject({
  /** Stable across restarts; see the module header. */
  streamName: z
    .string()
    .regex(CODE_STRING, "streamName must be a bounded CodeString")
    .refine((name) => !UUID_PATTERN.test(name.toLowerCase()), {
      message: "streamName must not be a UUID: it must be stable across restarts",
    }),
  wal: WalConfigSchema,
  publisher: PublisherConfigSchema.default({
    maxQueueDepth: DEFAULT_PUBLISH_QUEUE_MAX_DEPTH,
    maxQueueBytes: DEFAULT_PUBLISH_QUEUE_MAX_BYTES,
  }),
  /**
   * Gateway tick cadence, driving WAL fsync/rotation and staleness checks.
   *
   * MUST be at or below the effective `wal.fsyncIntervalMs`: the WAL writer
   * schedules nothing, so an idle recorder is only fsynced by this tick, and a
   * slower tick would make the published `dataLossBoundMs` a false claim
   * (round-1 review M2 — validated below, not merely documented).
   */
  tickIntervalMs: z.number().int().positive().default(1_000),
  markets: z.array(MarketConfigSchema),
  polymarket: PolymarketFeedConfigSchema.optional(),
  rtds: RtdsFeedConfigSchema.optional(),
  binance: BinanceFeedConfigSchema.optional(),
  coinbase: CoinbaseFeedConfigSchema.optional(),
});
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/** Parses and validates a configuration value, failing loudly. */
export function parseGatewayConfig(value: unknown): GatewayConfig {
  const parsed = GatewayConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new GatewayConfigurationError("invalid gateway configuration", {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map((part) => String(part)).join("."),
        message: issue.message,
      })),
    });
  }
  const config = parsed.data;
  if (
    config.polymarket === undefined &&
    config.rtds === undefined &&
    config.binance === undefined &&
    config.coinbase === undefined
  ) {
    throw new GatewayConfigurationError(
      "at least one feed must be configured; a gateway recording nothing is a deployment error",
    );
  }
  if (config.polymarket !== undefined && config.markets.length === 0) {
    throw new GatewayConfigurationError(
      "the Polymarket feed requires at least one configured market: subscriptions and the universe directory are configuration, not discovery (§9.2)",
    );
  }
  // Round-1 review M2: the WAL's published `dataLossBoundMs` IS
  // `fsyncIntervalMs`, and nothing but this gateway's tick drives an idle
  // writer's fsync. A tick slower than the fsync interval therefore advertises
  // a bound the deployment cannot keep — an idle final frame can sit unsynced
  // for a whole tick. That is a configuration defect, so it fails at startup.
  const effectiveFsyncIntervalMs = config.wal.fsyncIntervalMs ?? DEFAULT_FSYNC_INTERVAL_MS;
  if (config.tickIntervalMs > effectiveFsyncIntervalMs) {
    throw new GatewayConfigurationError(
      "tickIntervalMs must be at or below wal.fsyncIntervalMs: the WAL writer schedules nothing, so a slower tick would make the published dataLossBoundMs a false claim",
      {
        tickIntervalMs: config.tickIntervalMs,
        fsyncIntervalMs: effectiveFsyncIntervalMs,
        fsyncIntervalMsIsDefault: config.wal.fsyncIntervalMs === undefined,
      },
    );
  }
  const feedIds = [
    config.polymarket?.feedId,
    config.rtds?.feedId,
    config.binance?.feedId,
    config.coinbase?.feedId,
  ].filter((id): id is string => id !== undefined);
  if (new Set(feedIds).size !== feedIds.length) {
    throw new GatewayConfigurationError("feed ids must be distinct", { feedIds });
  }
  return config;
}
