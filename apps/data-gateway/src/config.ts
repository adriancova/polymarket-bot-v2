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

import { IsoTimestampSchema } from "@polymarket-bot/domain";
import { DEFAULT_FSYNC_INTERVAL_MS } from "@polymarket-bot/storage-wal";
import { parseReviewedSeries, type ReviewedSeries } from "@polymarket-bot/universe";
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
const DEFAULT_LIFECYCLE_FEED_ID = "polymarket-lifecycle";
const DEFAULT_LIFECYCLE_POLL_INTERVAL_MS = 10_000;
const DEFAULT_LIFECYCLE_FAILURE_ESCALATION = 3;
const DEFAULT_SERIES_ADMISSION_FEED_ID = "polymarket-series-admission";
const DEFAULT_SERIES_ADMISSION_POLL_INTERVAL_MS = 30_000;
const DEFAULT_SERIES_ADMISSION_FAILURE_ESCALATION = 3;
const DEFAULT_SERIES_ADMISSION_PAGE_LIMIT = 20;
const DEFAULT_SERIES_ADMISSION_MAXIMUM_PAGES = 3;

/**
 * The market lifecycle feed's request budget (`UNIV-4`), as a configuration
 * snapshot with its source (handoff §9.13): the venue's published IP-level
 * rate limit for Gamma `/markets` is **300 requests / 10 s** (the general
 * Gamma limit is 4,000 / 10 s; `docs/venue/verified-2026-09-16.md` §8, S-D24,
 * accessed 2026-09-16; `test/fixtures/venue/rate-limits/rate-limits.json`
 * `gamma_markets`). The STRICTER of the two figures is the one the door
 * budgets against, because `GET /markets/{id}` is under the `/markets` path
 * and the report does not say the per-endpoint figure excludes it. The feed
 * may use at most {@link LIFECYCLE_MAX_BUDGET_SHARE_PERCENT} of it, so that a
 * lifecycle poll can never crowd out the same IP's snapshot recovery reads or
 * a second gateway on the same host: 5 % of 300 / 10 s is 15 requests per
 * 10 s, i.e. 1.5 requests per second across every configured market.
 *
 * The arithmetic the door pins: `N markets × (10 000 ms / pollIntervalMs)`
 * requests per 10 s must be ≤ 15. At the default 10 s interval that admits
 * 15 markets; at 60 s, 90; at the 1 s floor, exactly one.
 */
export const GAMMA_MARKETS_RATE_LIMIT_PER_10S = 300;
export const LIFECYCLE_MAX_BUDGET_SHARE_PERCENT = 5;

/**
 * Floor on the lifecycle poll cadence (`UNIV-4`): 1 s.
 *
 * The venue documents no cadence for the polled surface, so the floor is the
 * gateway's own reasoning, stated: (1) below one request per second a single
 * market alone exceeds the 1.5 req/s budget above; (2) the lifecycle is a
 * slow-moving catalog fact — a market that closes between two polls is seen
 * late by at most one interval, and no interval makes a poll an observed
 * event (register U-12); (3) the market WebSocket already delivers the
 * fast-moving data. Faster polling buys nothing the design can use and
 * spends a shared IP budget.
 */
export const MIN_LIFECYCLE_POLL_INTERVAL_MS = 1_000;

/**
 * The series-admission feed's request budget (`ROLLOVER-1`), as a
 * configuration snapshot with its source (handoff §9.13): the venue's published
 * limit for Gamma `/events` is **500 requests / 10 s** and the CLOB's general
 * limit **9,000 / 10 s** (`docs/venue/verified-2026-10-04.md` "Method", S-D24
 * lines 33-36 and 78, re-fetched 2026-10-04). `GET /events/keyset` is under
 * `/events`. The feed may use at most {@link SERIES_ADMISSION_MAX_BUDGET_SHARE_PERCENT}
 * of each, the lifecycle feed's share: per series, at most `maximumPages`
 * keyset reads and at most `maximumConcurrentWindows` CLOB reads per cycle.
 */
export const GAMMA_EVENTS_RATE_LIMIT_PER_10S = 500;
export const CLOB_GENERAL_RATE_LIMIT_PER_10S = 9_000;
export const SERIES_ADMISSION_MAX_BUDGET_SHARE_PERCENT = 5;

/** Floor on the series-admission cadence: 5 s (a window opens every 15 minutes). */
export const MIN_SERIES_ADMISSION_POLL_INTERVAL_MS = 5_000;

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
  /**
   * The `{id}` path value of the documented polled market-state surface,
   * `GET https://gamma-api.polymarket.com/markets/{id}` (`UNIV-4`, D-30),
   * exactly as the operator verified it for this market. The repository
   * does not assert whether that identifier is the numeric Gamma id or the
   * condition id (`packages/polymarket-public/src/market-state/fetcher.ts`
   * records why), so it is configuration, not derivation. Optional here;
   * REQUIRED by the door for every market when the `lifecycle` feed is
   * configured.
   */
  gammaMarketId: z.string().min(1).max(200).optional(),
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
  /**
   * §4.2 hard capacity threshold over the whole WAL root, every epoch in it
   * (ADR-028 D5, `WALCAP-1`). `null` disables it; on the laptop host profile
   * it is required ({@link LAPTOP_PAPER_HOST_PROFILE}).
   */
  maxTotalBytes: z.number().int().positive().nullable().optional(),
});

/**
 * The ADR-025 laptop PAPER host profile, as a gateway configuration declares
 * it (`WALCAP-1`, ADR-028 Decision 5.1: "On this profile `maxTotalBytes` must
 * be set. `null` is refused.").
 *
 * Nothing in the repository identified the profile before this marker: the
 * host configuration is `HOST-1`'s, and no field, path or environment value
 * said "laptop". The marker is therefore OPT-IN and narrow on purpose. A
 * configuration that declares it is refused at startup unless
 * `wal.maxTotalBytes` is a positive number; a configuration that does not
 * declare it is judged exactly as before, so CI, test and compose
 * configurations are unchanged. It does not detect the host and does not
 * change any other value. `HOST-1`'s host configuration declares it, and its
 * start script refuses a missing `maxTotalBytes` too (work plan, `HOST-1`
 * acceptance), so the two checks are independent.
 */
export const LAPTOP_PAPER_HOST_PROFILE = "laptop-paper";

/** The host profiles a configuration may declare. Anything else is refused by the strict schema. */
export const HostProfileSchema = z.enum([LAPTOP_PAPER_HOST_PROFILE]);

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
 * The market lifecycle feed (`UNIV-4`, closeout blocker B10): the producer
 * of `MarketOpened` / `MarketClosing` from the venue's documented polled
 * market-state surface. See `feeds/market-lifecycle.ts` for the derivation
 * rules and the venue licence.
 */
export const LifecycleFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default(DEFAULT_LIFECYCLE_FEED_ID),
  /** Defaults to the documented Gamma origin. Overridable for a local stub. */
  baseUrl: z.string().min(1).optional(),
  /** ≥ {@link MIN_LIFECYCLE_POLL_INTERVAL_MS}; budgeted by the door (module constants above). */
  pollIntervalMs: z.number().int().positive().default(DEFAULT_LIFECYCLE_POLL_INTERVAL_MS),
  /**
   * Consecutive failed polls (transport, non-2xx, undocumented body) after
   * which the feed is a STALL: `FeedStale` is published and the gateway's
   * `GATEWAY_FEED_STALL` incident opens, exactly as for a silent socket.
   */
  consecutiveFailureThreshold: z.number().int().positive().default(DEFAULT_LIFECYCLE_FAILURE_ESCALATION),
});

/**
 * Bounds on the publisher's admission queue (§8.3: every queue is bounded).
 *
 * Safety parameters, not throughput knobs. Raising either one buys tolerance
 * for a longer transport stall and costs memory plus a longer window of events
 * that exist only in the WAL; crossing either one is a terminal publication
 * halt with a PAGE incident, never a drop.
 */
/**
 * The SERIES-ADMISSION feed (`ROLLOVER-1`; ADR-030): in PAPER and BACKTEST
 * only, each reviewed series admits every new window that matches it exactly.
 * See `feeds/series-admission.ts` for the cycle, the venue surfaces and the
 * judge. Each `series` entry is a reviewed series document, parsed by
 * `@polymarket-bot/universe`'s own door at startup (`checkSeriesAdmission`).
 */
export const SeriesAdmissionFeedConfigSchema = z.strictObject({
  feedId: FeedIdSchema.default(DEFAULT_SERIES_ADMISSION_FEED_ID),
  /** Defaults to the documented Gamma origin. Overridable for a local stub. */
  gammaBaseUrl: z.string().min(1).optional(),
  /** Defaults to the documented CLOB origin. Overridable for a local stub. */
  clobBaseUrl: z.string().min(1).optional(),
  pollIntervalMs: z.number().int().positive().default(DEFAULT_SERIES_ADMISSION_POLL_INTERVAL_MS),
  consecutiveFailureThreshold: z.number().int().positive().default(DEFAULT_SERIES_ADMISSION_FAILURE_ESCALATION),
  /** `limit` of one keyset page: 1 to 100 (F-07). */
  pageLimit: z.number().int().min(1).max(100).default(DEFAULT_SERIES_ADMISSION_PAGE_LIMIT),
  /** Keyset pages read per series per cycle. */
  maximumPages: z.number().int().min(1).max(10).default(DEFAULT_SERIES_ADMISSION_MAXIMUM_PAGES),
  /**
   * How long before its `eventStartTime` a window is judged and admitted.
   * REQUIRED: how early a run takes on a window is the operator's choice, not
   * a default nobody made.
   */
  admissionLeadSeconds: z.number().int().min(0).max(86_400),
  /** The reviewed series, each parsed by the universe door (non-empty, distinct). */
  series: z.array(z.unknown()).min(1).max(8),
});

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
  /**
   * The host profile this configuration is for, when it is one with rules of
   * its own ({@link LAPTOP_PAPER_HOST_PROFILE}). Optional; see there.
   */
  hostProfile: HostProfileSchema.optional(),
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
  lifecycle: LifecycleFeedConfigSchema.optional(),
  /** `ROLLOVER-1` (ADR-030): series auto-admission, PAPER and BACKTEST only. */
  seriesAdmission: SeriesAdmissionFeedConfigSchema.optional(),
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
  [
    "lifecycle",
    [
      ["feedId", DEFAULT_LIFECYCLE_FEED_ID],
      ["pollIntervalMs", DEFAULT_LIFECYCLE_POLL_INTERVAL_MS],
      ["consecutiveFailureThreshold", DEFAULT_LIFECYCLE_FAILURE_ESCALATION],
    ],
  ],
  [
    "seriesAdmission",
    [
      ["feedId", DEFAULT_SERIES_ADMISSION_FEED_ID],
      ["pollIntervalMs", DEFAULT_SERIES_ADMISSION_POLL_INTERVAL_MS],
      ["consecutiveFailureThreshold", DEFAULT_SERIES_ADMISSION_FAILURE_ESCALATION],
      ["pageLimit", DEFAULT_SERIES_ADMISSION_PAGE_LIMIT],
      ["maximumPages", DEFAULT_SERIES_ADMISSION_MAXIMUM_PAGES],
    ],
  ],
]);

/** Top-level keys with a scalar `.default()`. */
export const DEFAULTED_ROOT_KEYS: readonly (readonly [string, unknown])[] = [
  ["tickIntervalMs", DEFAULT_TICK_INTERVAL_MS],
];

/**
 * Blocks whose WHOLE object the schema defaults, so they exist even when the
 * operator wrote nothing. `publisher` is the only one: the feed blocks
 * (`seriesAdmission` included) are `.optional()`, and materializing an absent
 * feed would invent a subscription.
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
    config.coinbase === undefined &&
    config.lifecycle === undefined &&
    config.seriesAdmission === undefined
  ) {
    throw new GatewayConfigurationError(
      "at least one feed must be configured; a gateway recording nothing is a deployment error",
    );
  }
  // ADR-028 D5.1 on the ADR-025 laptop profile: a hard stop that is not set
  // is no stop at all, and the disk fills instead (`WALCAP-1`).
  if (
    config.hostProfile === LAPTOP_PAPER_HOST_PROFILE &&
    (config.wal.maxTotalBytes === undefined || config.wal.maxTotalBytes === null)
  ) {
    throw new GatewayConfigurationError(
      `the ${LAPTOP_PAPER_HOST_PROFILE} host profile requires wal.maxTotalBytes: ADR-028 Decision 5.1 refuses a null or missing cap on this profile; set it below the free disk, with room for pins, the research tier, PostgreSQL and backups (Decision 5.2)`,
      {
        hostProfile: config.hostProfile,
        maxTotalBytes: config.wal.maxTotalBytes === undefined ? "absent" : null,
      },
    );
  }
  // ADR-030 ("What it amends", `config.ts`): subscriptions and the universe
  // directory are configuration, not discovery (§9.2) — except for the admitted
  // windows of a reviewed series, so a gateway whose markets all come from
  // series admission may configure none.
  if (config.polymarket !== undefined && config.markets.length === 0 && config.seriesAdmission === undefined) {
    throw new GatewayConfigurationError(
      "the Polymarket feed requires at least one configured market or a seriesAdmission block: subscriptions and the universe directory are configuration, not discovery (§9.2), except for the admitted windows of a reviewed series (ADR-030)",
    );
  }
  if (config.seriesAdmission !== undefined) {
    checkSeriesAdmission(config, config.seriesAdmission);
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
  if (config.lifecycle !== undefined) {
    checkLifecycleConfiguration(config, config.lifecycle);
  }
  const feedIds = [
    config.polymarket?.feedId,
    config.rtds?.feedId,
    config.binance?.feedId,
    config.coinbase?.feedId,
    config.lifecycle?.feedId,
    config.seriesAdmission?.feedId,
  ].filter((id): id is string => id !== undefined);
  if (new Set(feedIds).size !== feedIds.length) {
    throw new GatewayConfigurationError("feed ids must be distinct", { feedIds });
  }
  return config;
}

/** Requests per 10 s the lifecycle feed may issue: the budgeted share of the venue's figure. */
export function lifecycleRequestBudgetPer10s(): number {
  return (GAMMA_MARKETS_RATE_LIMIT_PER_10S * LIFECYCLE_MAX_BUDGET_SHARE_PERCENT) / 100;
}

/** Requests per 10 s a configuration would issue: one per market per interval. */
export function lifecycleRequestsPer10s(marketCount: number, pollIntervalMs: number): number {
  return (marketCount * 10_000) / pollIntervalMs;
}

/**
 * The lifecycle feed's own startup checks (`UNIV-4`), each a configuration
 * defect that fails closed at startup rather than an hour later:
 *
 * 1. at least one market — a lifecycle feed with nothing to poll is the same
 *    deployment error as a Polymarket feed with no markets (§9.2);
 * 2. every market names its `gammaMarketId` — the `{id}` the documented
 *    surface takes is configuration, and a market without one cannot be
 *    polled, so the feed would silently never open it;
 * 3. every configured `openTime` / `closeTime` is an ISO-8601 instant — the
 *    frozen `MarketOpened.openedAt` / `MarketClosing.closesAt` contracts
 *    require one, and a string that fails there fails at publish time as an
 *    envelope rejection, which is the wrong time to learn it;
 * 4. the cadence floor {@link MIN_LIFECYCLE_POLL_INTERVAL_MS};
 * 5. the request budget: `markets × 10 000 / pollIntervalMs` per 10 s must
 *    not exceed {@link LIFECYCLE_MAX_BUDGET_SHARE_PERCENT} % of
 *    {@link GAMMA_MARKETS_RATE_LIMIT_PER_10S} — the arithmetic is in the
 *    refusal so an operator can size the interval from the message.
 */
function checkLifecycleConfiguration(
  config: GatewayConfig,
  lifecycle: NonNullable<GatewayConfig["lifecycle"]>,
): void {
  if (config.markets.length === 0 && config.seriesAdmission === undefined) {
    throw new GatewayConfigurationError(
      "the lifecycle feed requires at least one configured market or a seriesAdmission block: subscriptions and the universe directory are configuration, not discovery (§9.2), except for the admitted windows of a reviewed series (ADR-030)",
    );
  }
  for (const market of config.markets) {
    if (market.gammaMarketId === undefined) {
      throw new GatewayConfigurationError(
        "the lifecycle feed requires gammaMarketId on every configured market: GET /markets/{id} takes a path value the repository does not derive (UNIV-4)",
        { internalMarketId: market.internalMarketId },
      );
    }
    for (const key of ["openTime", "closeTime"] as const) {
      const value = market.parameters[key];
      if (value !== undefined && !IsoTimestampSchema.safeParse(value).success) {
        throw new GatewayConfigurationError(
          `the lifecycle feed requires parameters.${key} to be an ISO-8601 instant when present: it becomes a frozen lifecycle event instant`,
          { internalMarketId: market.internalMarketId, [key]: value },
        );
      }
    }
  }
  if (lifecycle.pollIntervalMs < MIN_LIFECYCLE_POLL_INTERVAL_MS) {
    throw new GatewayConfigurationError(
      `lifecycle.pollIntervalMs must be at least ${String(MIN_LIFECYCLE_POLL_INTERVAL_MS)} ms: the venue documents no cadence, and below one request per second a single market alone exceeds the feed's request budget`,
      { pollIntervalMs: lifecycle.pollIntervalMs, minimumMs: MIN_LIFECYCLE_POLL_INTERVAL_MS },
    );
  }
  // `ROLLOVER-1`: every admitted window is polled too, up to each reviewed
  // series' cap, so the budget counts the configured markets PLUS the caps.
  const polled = config.markets.length + admittedWindowCapacity(config);
  const requestsPer10s = lifecycleRequestsPer10s(polled, lifecycle.pollIntervalMs);
  const budgetPer10s = lifecycleRequestBudgetPer10s();
  if (requestsPer10s > budgetPer10s) {
    throw new GatewayConfigurationError(
      `the lifecycle feed would issue ${String(polled)} markets × (10000 ms / ${String(lifecycle.pollIntervalMs)} ms) = ${String(requestsPer10s)} requests per 10 s, over its budget of ${String(budgetPer10s)} per 10 s (${String(LIFECYCLE_MAX_BUDGET_SHARE_PERCENT)} % of the venue's documented ${String(GAMMA_MARKETS_RATE_LIMIT_PER_10S)} / 10 s for Gamma /markets); raise pollIntervalMs or configure fewer markets (or lower a series' maximumConcurrentWindows)`,
      {
        markets: polled,
        configuredMarkets: config.markets.length,
        pollIntervalMs: lifecycle.pollIntervalMs,
        requestsPer10s,
        budgetPer10s,
        venueRequestsPer10s: GAMMA_MARKETS_RATE_LIMIT_PER_10S,
        budgetSharePercent: LIFECYCLE_MAX_BUDGET_SHARE_PERCENT,
      },
    );
  }
}

/**
 * `ROLLOVER-1`: the reviewed series a configuration's `seriesAdmission` block
 * names, each parsed by `@polymarket-bot/universe`'s own door. Throws on a
 * series the door refuses (the configuration door already ran
 * {@link checkSeriesAdmission}, so a parsed configuration never does).
 */
export function reviewedSeriesOf(config: GatewayConfig): readonly { readonly series: ReviewedSeries; readonly configHash: string }[] {
  const block = config.seriesAdmission;
  if (block === undefined) return [];
  return block.series.map((document, index) => {
    const parsed = parseReviewedSeries(document);
    if (!parsed.ok) {
      throw new GatewayConfigurationError(`seriesAdmission.series[${String(index)}] is not a reviewed series`, { issues: parsed.issues });
    }
    return { series: parsed.series, configHash: parsed.configHash };
  });
}

/** How many admitted windows the configuration can hold live at once: the sum of the caps. */
function admittedWindowCapacity(config: GatewayConfig): number {
  return reviewedSeriesOf(config).reduce((total, entry) => total + entry.series.maximumConcurrentWindows, 0);
}

/**
 * The series-admission feed's own startup checks (`ROLLOVER-1`), each a
 * configuration defect that fails closed at startup:
 *
 * 1. the `polymarket` and `lifecycle` blocks are configured — an admitted
 *    window is subscribed (books) and opened and closed (lifecycle) through
 *    them; without either it could never trade;
 * 2. every series is a reviewed series (the universe door), with distinct
 *    series ids and distinct Gamma series ids;
 * 3. the cadence floor {@link MIN_SERIES_ADMISSION_POLL_INTERVAL_MS};
 * 4. the request budget: `Σ maximumPages × 10 000 / pollIntervalMs` per 10 s
 *    within {@link SERIES_ADMISSION_MAX_BUDGET_SHARE_PERCENT} % of Gamma
 *    `/events`, and `Σ maximumConcurrentWindows × 10 000 / pollIntervalMs`
 *    within the same share of the CLOB's general limit.
 *
 * The RUN MODE is not configuration: the feed refuses to start outside PAPER
 * and BACKTEST from the process environment (`feeds/series-admission.ts`).
 */
function checkSeriesAdmission(
  config: GatewayConfig,
  block: NonNullable<GatewayConfig["seriesAdmission"]>,
): void {
  if (config.polymarket === undefined || config.lifecycle === undefined) {
    throw new GatewayConfigurationError(
      "seriesAdmission requires the polymarket and lifecycle blocks: an admitted window is subscribed through the first and opened and closed through the second (ADR-030 Decision 1.3)",
      { polymarket: config.polymarket !== undefined, lifecycle: config.lifecycle !== undefined },
    );
  }
  const parsed = block.series.map((document, index) => {
    const result = parseReviewedSeries(document);
    if (!result.ok) {
      throw new GatewayConfigurationError(
        `seriesAdmission.series[${String(index)}] is not a reviewed series: a window is admitted only against reviewed configuration (ADR-030 Decision 1.1)`,
        { issues: result.issues },
      );
    }
    return result.series;
  });
  const ids = parsed.map((series) => series.seriesId);
  const gammaIds = parsed.map((series) => series.venue.gammaSeriesId);
  if (new Set(ids).size !== ids.length || new Set(gammaIds).size !== gammaIds.length) {
    throw new GatewayConfigurationError("seriesAdmission.series must name each series, and each Gamma series id, once", { ids, gammaIds });
  }
  if (block.pollIntervalMs < MIN_SERIES_ADMISSION_POLL_INTERVAL_MS) {
    throw new GatewayConfigurationError(
      `seriesAdmission.pollIntervalMs must be at least ${String(MIN_SERIES_ADMISSION_POLL_INTERVAL_MS)} ms`,
      { pollIntervalMs: block.pollIntervalMs },
    );
  }
  const share = SERIES_ADMISSION_MAX_BUDGET_SHARE_PERCENT / 100;
  const gammaPer10s = (parsed.length * block.maximumPages * 10_000) / block.pollIntervalMs;
  const gammaBudget = GAMMA_EVENTS_RATE_LIMIT_PER_10S * share;
  if (gammaPer10s > gammaBudget) {
    throw new GatewayConfigurationError(
      `seriesAdmission would issue ${String(parsed.length)} series × ${String(block.maximumPages)} pages × (10000 ms / ${String(block.pollIntervalMs)} ms) = ${String(gammaPer10s)} keyset requests per 10 s, over its budget of ${String(gammaBudget)} (${String(SERIES_ADMISSION_MAX_BUDGET_SHARE_PERCENT)} % of Gamma /events' documented ${String(GAMMA_EVENTS_RATE_LIMIT_PER_10S)} / 10 s); raise pollIntervalMs or lower maximumPages`,
      { gammaPer10s, gammaBudget },
    );
  }
  const clobPer10s = (parsed.reduce((total, series) => total + series.maximumConcurrentWindows, 0) * 10_000) / block.pollIntervalMs;
  const clobBudget = CLOB_GENERAL_RATE_LIMIT_PER_10S * share;
  if (clobPer10s > clobBudget) {
    throw new GatewayConfigurationError(
      `seriesAdmission could issue ${String(clobPer10s)} CLOB market-info requests per 10 s, over its budget of ${String(clobBudget)} (${String(SERIES_ADMISSION_MAX_BUDGET_SHARE_PERCENT)} % of the CLOB's documented ${String(CLOB_GENERAL_RATE_LIMIT_PER_10S)} / 10 s)`,
      { clobPer10s, clobBudget },
    );
  }
}
