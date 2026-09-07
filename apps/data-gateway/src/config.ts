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
 *
 * ## The parse is not the door (`REC-1`, ADR-020 §3)
 *
 * `zod` reads a schema's declared keys through the prototype chain and a
 * get-only inherited accessor defeats a `.default()`, both of which were
 * measured LIVE on this exact function (`schema-boundary.md` §3). The schema
 * below is unchanged; what changed is that `parseGatewayConfig` materializes
 * the operator's value prototype-free before the schema runs, applies the
 * declared defaults itself, and runs every startup check against its own
 * prototype-free record. See `./config-door.ts` for which of D1–D4 this door
 * performs and which it does not.
 */

import { DEFAULT_FSYNC_INTERVAL_MS } from "@polymarket-bot/storage-wal";
import { z } from "zod";

import {
  containedConfigParse,
  isOwnRecord,
  ownGatewayConfig,
  readOwnConfig,
  type BlockDefaults,
} from "./config-door.js";
import { GatewayConfigurationError } from "./errors.js";
import {
  DEFAULT_PUBLISH_QUEUE_MAX_BYTES,
  DEFAULT_PUBLISH_QUEUE_MAX_DEPTH,
} from "./publisher.js";

/** Matches the transport's own stream-name discipline: a bounded code string. */
const CODE_STRING = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/u;

/**
 * Every value this module `.default()`s, named once.
 *
 * ONE SOURCE OF TRUTH PER DEFAULT. The schema below is written in these
 * constants and so is the door's `DEFAULTED_KEYS` table, because the door
 * applies the defaults itself: a get-only inherited accessor defeats `zod`'s
 * own `.default()` assembly (ADR-020 §1 class 3, measured LIVE on
 * `tickIntervalMs`), so the defaulted value can never be taken from the
 * library's output. `./config.test.ts` pins that the table covers exactly the
 * keys the schema defaults, so adding a `.default()` without a table row fails
 * there rather than silently losing the default under pollution.
 */
const DEFAULT_TICK_INTERVAL_MS = 1_000;
const DEFAULT_POLYMARKET_FEED_ID = "polymarket-market";
const DEFAULT_RTDS_FEED_ID = "polymarket-rtds-twap";
const DEFAULT_RTDS_MAX_OBSERVATION_AGE_MS = 300_000;
const DEFAULT_BINANCE_FEED_ID = "binance-reference";
const DEFAULT_BINANCE_STALENESS_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_BINANCE_UNAUTHORIZED_ESCALATION = 3;
const DEFAULT_COINBASE_FEED_ID = "coinbase-reference";
const DEFAULT_COINBASE_SNAPSHOT_FAILURE_ESCALATION = 3;
const DEFAULT_COINBASE_RECONNECT_LOOP_ESCALATION = 5;

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
  feedId: FeedIdSchema.default(DEFAULT_POLYMARKET_FEED_ID),
  url: z.string().min(1).optional(),
  customFeatureEnabled: z.boolean().optional(),
  maximumAssetsPerSubscriptionFrame: z.number().int().positive().optional(),
  heartbeatIntervalMs: z.number().int().positive().optional(),
  pongTimeoutMs: z.number().int().positive().optional(),
  stalenessCheckIntervalMs: z.number().int().positive().optional(),
  snapshotBaseUrl: z.string().min(1).optional(),
});

export const RtdsFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default(DEFAULT_RTDS_FEED_ID),
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
  maxObservationAgeMs: z.number().int().positive().default(DEFAULT_RTDS_MAX_OBSERVATION_AGE_MS),
});

export const BinanceFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default(DEFAULT_BINANCE_FEED_ID),
  symbols: z.array(z.string().min(1)).min(1),
  /** REQUIRED by the adapter: Binance documents no message cadence. */
  stalenessThresholdMs: z.number().int().positive(),
  stalenessCheckIntervalMs: z.number().int().positive().default(DEFAULT_BINANCE_STALENESS_CHECK_INTERVAL_MS),
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
  unauthorizedEventEscalationThreshold: z.number().int().positive().default(DEFAULT_BINANCE_UNAUTHORIZED_ESCALATION),
});

export const CoinbaseFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default(DEFAULT_COINBASE_FEED_ID),
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
  snapshotFailureEscalationThreshold: z.number().int().positive().default(DEFAULT_COINBASE_SNAPSHOT_FAILURE_ESCALATION),
  /** Same escalation for consecutive failed connection attempts. */
  reconnectLoopEscalationThreshold: z.number().int().positive().default(DEFAULT_COINBASE_RECONNECT_LOOP_ESCALATION),
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
  tickIntervalMs: z.number().int().positive().default(DEFAULT_TICK_INTERVAL_MS),
  markets: z.array(MarketConfigSchema),
  polymarket: PolymarketFeedConfigSchema.optional(),
  rtds: RtdsFeedConfigSchema.optional(),
  binance: BinanceFeedConfigSchema.optional(),
  coinbase: CoinbaseFeedConfigSchema.optional(),
});
export type GatewayConfig = z.infer<typeof GatewayConfigSchema>;

/**
 * Every `.default()` in this module, by the block it lives in.
 *
 * The door applies these itself (see `./config-door.ts`). `./config.test.ts`
 * pins that this table's keys are exactly the keys `GatewayConfigSchema`
 * defaults, so a new `.default()` cannot be added without a row here.
 */
export const DEFAULTED_KEYS: BlockDefaults = new Map<
  string,
  readonly (readonly [string, unknown])[]
>([
  [
    "publisher",
    [
      ["maxQueueDepth", DEFAULT_PUBLISH_QUEUE_MAX_DEPTH],
      ["maxQueueBytes", DEFAULT_PUBLISH_QUEUE_MAX_BYTES],
    ],
  ],
  ["polymarket", [["feedId", DEFAULT_POLYMARKET_FEED_ID]]],
  [
    "rtds",
    [
      ["feedId", DEFAULT_RTDS_FEED_ID],
      ["maxObservationAgeMs", DEFAULT_RTDS_MAX_OBSERVATION_AGE_MS],
    ],
  ],
  [
    "binance",
    [
      ["feedId", DEFAULT_BINANCE_FEED_ID],
      ["stalenessCheckIntervalMs", DEFAULT_BINANCE_STALENESS_CHECK_INTERVAL_MS],
      ["unauthorizedEventEscalationThreshold", DEFAULT_BINANCE_UNAUTHORIZED_ESCALATION],
    ],
  ],
  [
    "coinbase",
    [
      ["feedId", DEFAULT_COINBASE_FEED_ID],
      ["snapshotFailureEscalationThreshold", DEFAULT_COINBASE_SNAPSHOT_FAILURE_ESCALATION],
      ["reconnectLoopEscalationThreshold", DEFAULT_COINBASE_RECONNECT_LOOP_ESCALATION],
    ],
  ],
]);

/** Top-level keys with a scalar `.default()`. */
export const DEFAULTED_ROOT_KEYS: readonly (readonly [string, unknown])[] = [
  ["tickIntervalMs", DEFAULT_TICK_INTERVAL_MS],
];

/**
 * Blocks whose WHOLE object the schema defaults, so they exist even when the
 * operator wrote nothing. `publisher` is the only one: the four feed blocks are
 * `.optional()`, and materializing an absent feed would invent a subscription.
 */
export const DEFAULTED_BLOCKS: readonly string[] = ["publisher"];

/** Parses and validates a configuration value, failing loudly. */
export function parseGatewayConfig(value: unknown): GatewayConfig {
  // D1. Before the schema runs and before any property is read: rebuild the
  // operator's value as own data with no prototype. A get-only inherited
  // accessor is not read; an inherited feed block is not present.
  const read = readOwnConfig(value);
  if (!read.ok) {
    throw new GatewayConfigurationError("invalid gateway configuration", {
      issues: [{ path: "", message: read.detail }],
    });
  }
  const tree: unknown = read.value;

  const parsed = containedConfigParse(GatewayConfigSchema, tree);
  if (!parsed.ok) {
    throw new GatewayConfigurationError("invalid gateway configuration", {
      issues: parsed.issues,
    });
  }
  if (!isOwnRecord(tree)) {
    // Unreachable through the schema, which is a strict object; kept because a
    // door that cannot state what it holds is not a door.
    throw new GatewayConfigurationError("invalid gateway configuration", {
      issues: [{ path: "", message: "a gateway configuration is an object" }],
    });
  }
  // D3/D4. The configuration is built from the tree the operator wrote, with
  // the declared defaults applied by this door rather than taken from the
  // library's output, into a record with no prototype.
  const config = ownGatewayConfig(
    tree,
    DEFAULTED_ROOT_KEYS,
    DEFAULTED_KEYS,
    DEFAULTED_BLOCKS,
  ) as GatewayConfig;
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
