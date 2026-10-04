/**
 * `THROUGHPUT-1c` review round 8, finding R8-H1, and the CLASS it belongs to:
 * no venue frame may vouch for a book before this trader has applied all of
 * it, whatever boundary on the frame's path cut it. Through REAL Redis, the
 * REAL `RedisMarketEventFeed` and the REAL `pump`.
 *
 * Rounds 6, 7 and 8 each found a new place where one frame could be cut so
 * that its delivered PREFIX confirmed the delivery session while the change
 * in its lost or unread TAIL was not applied:
 *
 * - R6-H1: an envelope the gateway's contract refused mid-frame, reported
 *   only AFTER the frame's accepted siblings (`74e17ca`);
 * - R7-H1: a frame published across two transport calls, an outage between
 *   them (`2d29b2d`);
 * - R8-H1: a frame published whole, in one call, but handed to the loop by
 *   `RedisMarketEventFeed` across two polls, because it is longer than
 *   `receiveBatchSize` (`298199d`; the example configuration ships 128).
 *
 * r8 closes the class at the CONSUMER (`packages/trading-core/src/book-freshness.ts`,
 * `FrameCompletionGate`): a frame's session confirmations are used only once
 * the loop has processed a LATER event of the same gateway epoch from another
 * frame. Nothing weaker is trusted: not a short read, not a batch end, not a
 * transport call, not the feed's carry.
 *
 * What this file pins:
 *
 * 1. NAMED REGRESSIONS, each the published shape of one round's finding fed
 *    through Redis to the trader. Each admits 2 orders under
 *    `CONNECTION_CONFIRMED` at `298199d` and none now. The R6 and R7 shapes
 *    are what `74e17ca`'s and `2d29b2d`'s gateways published; the current
 *    gateway no longer publishes them, so they are rebuilt from its own
 *    output. That is the point: the trader must hold whatever the gateway
 *    does;
 * 2. a SEEDED RANDOMIZED PROPERTY, per boundary of the frame's path (handoff
 *    r8, "Every boundary"): frame sizes from 1 to twice the gateway's
 *    one-call limit, `receiveBatchSize` from 1 upward (128 included), the
 *    gateway's admission depth, the trader's ingest depth, how far the trader
 *    reads between publications, and one injected failure at the boundary.
 *    Property: when the frame carries the YES book's latest change (applied
 *    late, or lost), no order and no approval is ever admitted;
 * 3. CONTROLS that the property is not vacuous: the same harness, with a
 *    frame that carries no YES change and a successor that proves it whole,
 *    DOES vouch for the quiet YES book under `CONNECTION_CONFIRMED`, at
 *    every `receiveBatchSize`.
 *
 * The timeline everywhere: the lifecycle's `MarketOpened`; the YES book (asks
 * under the 0.35 trigger) at +1.000 s; nothing for the YES token until the
 * frame under test at +4.100 s, whose NO snapshots create the NO book Static
 * Bracket needs to enter. So the only evaluations that can enter are the ones
 * at or after that frame, and an entry with a YES change in the frame means
 * the frame vouched for a YES book its own change had not reached.
 *
 * The gateway is the REAL composition on the data-gateway suite's in-memory
 * harness (the real adapter, normalizer, driver, dispatcher and publisher;
 * the pattern of `throughput-1c-frame-split`). Every envelope it published is
 * then published to Redis in the SAME transport calls, by the real
 * `RedisStreamsEventTransport`, and read by the trader's own feed. The one
 * hand-written input is the reference feed (and, for a restarted process,
 * the market's opening), ingested before the first poll. Docker:
 * Testcontainers, no skip. PAPER only: no network beyond the local
 * container, no credential, no signer, no real order.
 */

import { IsoTimestampSchema, type EventEnvelope } from "@polymarket-bot/domain";
import { EventBusUnavailableError, RedisStreamsEventTransport, type EventSubscription } from "@polymarket-bot/event-bus";
import { uniqueStreamName } from "@polymarket-bot/event-bus/testing";
import type { PublicHttpRequest, PublicHttpResponse } from "@polymarket-bot/polymarket-public";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RedisMarketEventFeed } from "../../../apps/trader/src/adapters/redis-feed.js";
import { pump } from "../../../apps/trader/src/pump.js";
import { buildHarness } from "../data-gateway/support/harness.js";
import {
  adr024Reproduction,
  CONDITION_ID,
  MARKET_ID,
  NO_TOKEN,
  T_CLOSE,
  T_OPEN,
  YES_TOKEN,
  ingested,
  resetEventIds,
  riskPolicy,
  strategyParams,
  traderConfig,
} from "./support/fixture.js";
import { assembleOrThrow, type Run } from "./support/run.js";
import { startReadyRedisContainer } from "./support/containers.js";

let redis: Awaited<ReturnType<typeof startReadyRedisContainer>>;
let redisUrl: string;

beforeAll(async () => {
  redis = await startReadyRedisContainer();
  redisUrl = redis.getConnectionUrl();
  for (let attempt = 1; ; attempt += 1) {
    try {
      const probe = await RedisStreamsEventTransport.connect({ connection: { url: redisUrl }, retention: { maxEvents: 10 } });
      await probe.close();
      break;
    } catch (failure) {
      if (!(failure instanceof EventBusUnavailableError) || attempt >= 5) throw failure;
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
}, 300_000);

afterAll(async () => {
  await redis?.stop();
});

// ---------------------------------------------------------------------------
// The venue's side
// ---------------------------------------------------------------------------

const GAMMA_BASE = "http://gamma.stub";
const BOOK_AGE_KEY = "quality.input_feed_ages@polymarket.book";
/** The gateway's limit for one transport call (`FRAME_RUN_MAX_ENVELOPES`). */
const ONE_CALL = 1_024;
const LATE_MS = Date.parse(T_OPEN) + 4_100;

const GATEWAY_MARKET = {
  internalMarketId: MARKET_ID,
  conditionId: CONDITION_ID,
  yesTokenId: YES_TOKEN,
  noTokenId: NO_TOKEN,
  gammaMarketId: "900001",
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
} as const;

const READY_MARKET = {
  conditionId: CONDITION_ID,
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

function bookEntry(tokenId: string, bids: readonly [string, string][], asks: readonly [string, string][]): unknown {
  return {
    event_type: "book",
    market: CONDITION_ID,
    asset_id: tokenId,
    bids: bids.map(([price, size]) => ({ price, size })),
    asks: asks.map(([price, size]) => ({ price, size })),
    hash: `hash-${tokenId}`,
    timestamp: "1772625600000",
  };
}

const noBook = (): unknown => bookEntry(NO_TOKEN, [["0.65", "200"]], [["0.66", "200"]]);
/** The YES change: its asks move to 0.80, above the 0.35 trigger. */
const yesAway = (): unknown => bookEntry(YES_TOKEN, [["0.79", "200"]], [["0.80", "200"]]);
/** A NO top-of-book event: the trader does not consume it, so it neither confirms nor proves. */
const noTopOfBook = (): unknown => ({
  event_type: "best_bid_ask",
  market: CONDITION_ID,
  asset_id: NO_TOKEN,
  best_bid: "0.65",
  best_ask: "0.66",
  spread: "0.01",
  timestamp: String(LATE_MS),
});
/** A YES change the gateway's envelope contract refuses (R6-H1: a five-digit ISO year). */
const refusedYesChange = (): unknown => ({
  event_type: "price_change",
  market: CONDITION_ID,
  timestamp: "253402300800000",
  price_changes: [{ asset_id: YES_TOKEN, price: "0.34", size: "0", side: "SELL", hash: "h-odd" }],
});
/** A YES change the adapter cannot normalize (X8: an undocumented side). */
const malformedYesChange = (): unknown => ({
  event_type: "price_change",
  market: CONDITION_ID,
  timestamp: String(LATE_MS),
  price_changes: [{ asset_id: YES_TOKEN, price: "0.34", size: "0", side: "SIDEWAYS", hash: "h-bad" }],
});
/** The successor: one more socket message, 100 ms after the frame under test, which proves it whole. */
const SUCCESSOR: readonly unknown[] = [bookEntry(NO_TOKEN, [["0.64", "200"]], [["0.66", "200"]])];

/** The §7.1 dispatch identity, unique per published envelope. */
function identityOf(envelope: EventEnvelope<unknown>): string {
  return `${envelope.gatewayEpoch}:${envelope.ingestSeq}`;
}

function repeat(count: number, entry: () => unknown): unknown[] {
  return Array.from({ length: count }, entry);
}

/** One injected failure on the gateway's side of the frame's path. */
type GatewayFault =
  | { readonly kind: "none" }
  /** The `call`-th transport call from +4.100 s on fails whole; publication halts. */
  | { readonly kind: "outage"; readonly call: number }
  /** The frame also carries, at entry `at`, a YES change the envelope contract refuses. */
  | { readonly kind: "envelope-refused"; readonly at: number }
  /** The frame also carries, at entry `at`, a YES change the adapter cannot normalize. */
  | { readonly kind: "malformed"; readonly at: number }
  /** The frame's raw record overflows the WAL queue: its events are suppressed. */
  | { readonly kind: "wal-refused" };

interface GatewayShape {
  /** NO snapshots in the frame under test, YES change and fault entries excluded. */
  readonly noCount: number;
  /** Where the YES change sits among the frame's entries; `undefined`: the frame has none. */
  readonly yesAt: number | undefined;
  /** The gateway's admission depth (the default is 1 024; the H1 operator ran 16 384). */
  readonly maxQueueDepth: number;
  /** A held call and a 200-event frame queued ahead of the frame (R7-H1's backlog). */
  readonly backlog: boolean;
  /** One more socket message, 100 ms later. */
  readonly successor: boolean;
  readonly fault: GatewayFault;
}

interface GatewayOutput {
  /** Every envelope the gateway published, grouped by the transport call that published it. */
  readonly calls: readonly (readonly EventEnvelope<unknown>[])[];
  readonly halts: readonly string[];
}

function lateFrame(shape: GatewayShape): unknown[] {
  const entries = repeat(shape.noCount, noBook);
  if (shape.fault.kind === "envelope-refused") entries.splice(shape.fault.at, 0, refusedYesChange());
  if (shape.fault.kind === "malformed") entries.splice(shape.fault.at, 0, malformedYesChange());
  if (shape.yesAt !== undefined) entries.splice(shape.yesAt, 0, yesAway());
  return entries;
}

/** The gateway timeline (file header), with every transport call recorded. */
async function gatewayRun(shape: GatewayShape): Promise<GatewayOutput> {
  const route = (request: PublicHttpRequest): PublicHttpResponse => {
    if (request.url.startsWith(`${GAMMA_BASE}/markets/`)) {
      return { status: 200, body: JSON.stringify(READY_MARKET) };
    }
    throw new Error(`unexpected request ${request.url}`);
  };
  const gateway = await buildHarness({
    config: {
      markets: [GATEWAY_MARKET],
      publisher: { maxQueueDepth: shape.maxQueueDepth },
      polymarket: { feedId: "polymarket-market" },
      lifecycle: { feedId: "polymarket-lifecycle", baseUrl: GAMMA_BASE, pollIntervalMs: 10_000 },
      // A one-frame WAL queue: the second of two frames delivered in one
      // synchronous burst is refused (`queue-overflow`).
      ...(shape.fault.kind === "wal-refused" ? { wal: { rootPath: "/wal", queueCapacity: 1 } } : {}),
    },
    http: route,
  });
  const transport = gateway.transport;
  // Keyed by the dispatch identity: the harness's deterministic event ids
  // repeat within one millisecond, `(gatewayEpoch, ingestSeq)` never does.
  const callOf = new Map<string, number>();
  // The first transport call from +4.100 s on, once the late part begins.
  const late: { firstCall: number | undefined } = { firstCall: undefined };
  transport.setPublishObserver((envelope) => {
    const call = transport.batchCalls;
    callOf.set(identityOf(envelope), call);
    if (shape.fault.kind === "outage" && late.firstCall !== undefined && call - late.firstCall === shape.fault.call) {
      transport.setUnavailable(true);
    }
  });
  gateway.timers.advance(Date.parse(T_OPEN) - gateway.clock.nowMs());
  gateway.gateway.start();
  await gateway.settle();
  const socket = gateway.polymarketSockets.current;
  socket.open();
  await gateway.settle();
  gateway.timers.advance(1_000);
  socket.message(JSON.stringify([bookEntry(YES_TOKEN, [["0.32", "200"], ["0.31", "300"]], [["0.34", "200"], ["0.35", "300"]])]));
  await gateway.settle();
  gateway.timers.advance(3_100);

  late.firstCall = transport.batchCalls + 1;
  const frame = lateFrame(shape);
  if (shape.backlog) {
    transport.stallPublishes();
    socket.message(JSON.stringify([noTopOfBook()]));
    // Let the first message's call start (and hang) before the rest is sent.
    await new Promise<void>((resolve) => setImmediate(resolve));
    socket.message(JSON.stringify(repeat(200, noTopOfBook)));
    socket.message(JSON.stringify(frame));
    transport.resumePublishes();
  } else if (shape.fault.kind === "wal-refused") {
    socket.message(JSON.stringify([noTopOfBook()]));
    socket.message(JSON.stringify(frame));
  } else {
    socket.message(JSON.stringify(frame));
  }
  await gateway.settle();
  if (shape.successor) {
    gateway.timers.advance(100);
    socket.message(JSON.stringify(SUCCESSOR));
    await gateway.settle();
  }
  await gateway.gateway.stop();

  const calls: EventEnvelope<unknown>[][] = [];
  let previous: number | undefined;
  for (const envelope of gateway.published()) {
    const call = callOf.get(identityOf(envelope));
    if (call === undefined) throw new Error(`no transport call recorded for ${identityOf(envelope)}`);
    if (call !== previous || calls.length === 0) calls.push([]);
    (calls[calls.length - 1] as EventEnvelope<unknown>[]).push(envelope);
    previous = call;
  }
  return { calls, halts: [...gateway.halts] };
}

// ---------------------------------------------------------------------------
// Redis, and the trader's side
// ---------------------------------------------------------------------------

/** One injected failure between the gateway's calls and the trader's evaluation. */
type ConsumerFault =
  | { readonly kind: "none" }
  /**
   * The REAL Redis transport refuses envelope `at` of the first call from
   * +4.100 s on (an envelope whose `receivedAt` its door refuses): it
   * publishes the call's prefix and nothing after it, and nothing more is
   * published (the gateway would halt).
   */
  | { readonly kind: "transport-refusal"; readonly at: number }
  /** The trader process stops after `afterPolls` polls; a new one resumes from the committed position. */
  | { readonly kind: "restart"; readonly afterPolls: number }
  /** The subscription throws on its `atRead`-th read: the pump halts `TRANSPORT_UNAVAILABLE`. */
  | { readonly kind: "read-failure"; readonly atRead: number }
  /**
   * Retention of 16 events, and the trader does not read from +4.100 s until
   * everything is published: what it had not read is trimmed, and the pump
   * halts `TRANSPORT_RESYNC_REQUIRED`.
   */
  | { readonly kind: "retention-trim" };

type Basis = "LAST_CHANGE" | "CONNECTION_CONFIRMED";

interface ConsumerShape {
  readonly basis: Basis;
  readonly receiveBatchSize: number;
  readonly ingestDepth: number;
  /** How many polls the trader makes after each call is published (cycled). */
  readonly pollsAfterCall: readonly number[];
  readonly fault: ConsumerFault;
}

interface Outcome {
  readonly orders: number;
  readonly approvals: number;
  readonly staleBookPauses: number;
  readonly halts: readonly string[];
  /** How many events the loop was handed per poll, over every process. */
  readonly batches: readonly number[];
  readonly framesSplit: number;
  readonly published: number;
  readonly readFailuresInjected: number;
}

/** The fixture document with both freshness gates at 2 000 ms, the given basis and depths. */
function config(consumer: ConsumerShape): Record<string, unknown> {
  const params = strategyParams() as { data_quality: Record<string, unknown> } & Record<string, unknown>;
  const policy = riskPolicy() as { freshness: Record<string, unknown> } & Record<string, unknown>;
  const base = traderConfig();
  const document = traderConfig({
    queues: { ingestMaximumDepth: consumer.ingestDepth, outboxMaximumDepth: 4_096 },
    riskPolicy: { ...policy, freshness: { ...policy.freshness, venueBookMaxAgeMs: 2_000 } },
    infrastructure: {
      ...(base["infrastructure"] as Record<string, unknown>),
      receiveBatchSize: consumer.receiveBatchSize,
    },
    bookFreshness:
      consumer.basis === "CONNECTION_CONFIRMED"
        ? { basis: consumer.basis, maximumLastChangeAgeMs: 30_000 }
        : { basis: consumer.basis },
  });
  const instances = document["instances"] as Record<string, unknown>[];
  const instance = instances[0] as Record<string, unknown>;
  instance["params"] = {
    ...params,
    version: 2,
    data_quality: { ...params.data_quality, maximum_book_age_ms: 2_000, book_age_feature_key: BOOK_AGE_KEY },
  };
  return document;
}

/** A subscription that throws on its `atRead`-th read, and is otherwise the real one. */
function failingRead(
  subscription: EventSubscription<unknown>,
  atRead: number,
  injected: { count: number },
): EventSubscription<unknown> {
  let reads = 0;
  return new Proxy(subscription, {
    get(target, property) {
      if (property === "receive") {
        return async (options: Parameters<EventSubscription<unknown>["receive"]>[0]) => {
          reads += 1;
          if (reads === atRead) {
            injected.count += 1;
            throw new EventBusUnavailableError("the transport is unreachable (injected read failure)");
          }
          return await target.receive(options);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

interface TraderProcess {
  readonly run: Run;
  readonly feed: RedisMarketEventFeed;
  readonly transport: RedisStreamsEventTransport;
  readonly batches: number[];
  /** How many read failures were injected into this process's subscription. */
  readonly readFailures: { count: number };
  closed: boolean;
}

/** One trader process: assembled, given the hand-written preamble, subscribed. */
async function startProcess(
  consumer: ConsumerShape,
  stream: string,
  consumerId: string,
  retention: number,
  restarted: boolean,
): Promise<TraderProcess> {
  // `CADENCE-1` (ADR-026 D1.6): this file pins book freshness at EACH
  // evaluation of a timeline written for ADR-024's per-frame cadence (an entry
  // needs the book evaluations 100 ms apart), so it REPRODUCES that cadence.
  const run = assembleOrThrow({
    config: config(consumer),
    evaluationCadence: adr024Reproduction("test/integration/paper-trader/throughput-1c-consumer-frame-proof-redis.test.ts"),
  });
  resetEventIds();
  // The reference feed (hand-written, see the header), just before the open.
  const preamble = [
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100000", size: "0.5" },
      { receivedAt: "2026-03-04T11:59:58.000Z", ingestSeq: 1, source: "binance" },
    ),
    ingested(
      "ReferenceTradeObserved",
      { venue: "binance", symbol: "BTCUSDT", price: "100100", size: "0.25" },
      { receivedAt: "2026-03-04T11:59:59.000Z", ingestSeq: 2, source: "binance" },
    ),
  ];
  // A restarted process resumes after the stream's `MarketOpened`, so its
  // opening is hand-written too: without it the market is not open and the
  // process could never admit anything (a vacuous run).
  if (restarted) {
    preamble.push(
      ingested(
        "MarketOpened",
        { internalMarketId: MARKET_ID, conditionId: CONDITION_ID, openedAt: T_OPEN },
        { receivedAt: T_OPEN, ingestSeq: 3, source: "polymarket" },
      ),
    );
  }
  // One at a time: the ingest queue may be as shallow as one event.
  for (const event of preamble) {
    expect(run.trader.loop.ingest(event)).toBe(true);
    await run.trader.loop.drain();
  }
  // The process clock at the open: no process lag at any stream event (ADR-023 D7).
  run.parts.clock.positionAt(T_OPEN, 1_000_000n);
  const transport = await RedisStreamsEventTransport.connect({ connection: { url: redisUrl }, retention: { maxEvents: retention } });
  const subscription = await transport.subscribe({ stream, consumerId });
  const readFailures = { count: 0 };
  const wrapped =
    consumer.fault.kind === "read-failure" && !restarted
      ? failingRead(subscription, consumer.fault.atRead, readFailures)
      : subscription;
  const batches: number[] = [];
  const real = new RedisMarketEventFeed({ subscription: wrapped, maxEvents: consumer.receiveBatchSize });
  // Every batch the loop is handed is counted (the real feed, observed).
  const feed = new Proxy(real, {
    get(target, property) {
      if (property === "poll") {
        return async () => {
          const polled = await target.poll();
          if (polled.ok) batches.push(polled.value.length);
          return polled;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { run, feed, transport, batches, readFailures, closed: false };
}

async function stopProcess(traderProcess: TraderProcess): Promise<void> {
  if (traderProcess.closed) return;
  traderProcess.closed = true;
  await traderProcess.feed.close();
  await traderProcess.transport.close();
}

async function poll(traderProcess: TraderProcess): Promise<void> {
  await pump({
    loop: traderProcess.run.trader.loop,
    feed: traderProcess.feed,
    halts: traderProcess.run.trader.halts,
    maxPolls: 1,
  });
}

/**
 * Publishes the gateway's calls to Redis one by one, the trader reading
 * between them, with the consumer's fault injected; then reads to the end.
 */
async function trade(gateway: GatewayOutput, consumer: ConsumerShape): Promise<Outcome> {
  const stream = uniqueStreamName("tp1c-r8-frame-proof");
  const consumerId = "tp1c-r8-trader";
  const retention = consumer.fault.kind === "retention-trim" ? 16 : 100_000;
  const publisher = await RedisStreamsEventTransport.connect({ connection: { url: redisUrl }, retention: { maxEvents: retention } });
  const processes: TraderProcess[] = [await startProcess(consumer, stream, consumerId, retention, false)];
  let current = processes[0] as TraderProcess;
  let pollsMade = 0;
  let published = 0;
  const step = async (polls: number): Promise<void> => {
    for (let index = 0; index < polls; index += 1) {
      await poll(current);
      pollsMade += 1;
      if (consumer.fault.kind === "restart" && pollsMade === consumer.fault.afterPolls) {
        // The process stops here: what it committed is where the next resumes.
        await stopProcess(current);
        current = await startProcess(consumer, stream, consumerId, retention, true);
        processes.push(current);
      }
    }
  };
  try {
    for (const [index, call] of gateway.calls.entries()) {
      const isLate = Date.parse(call[0]?.receivedAt ?? T_OPEN) >= LATE_MS;
      const batch = [...call];
      let refusedAt: number | undefined;
      if (consumer.fault.kind === "transport-refusal" && isLate) {
        // Envelope `at` of the first late call is replaced by one whose
        // `receivedAt` the real transport's door refuses: it publishes the
        // call's prefix and attempts nothing after it.
        refusedAt = Math.min(consumer.fault.at, batch.length - 1);
        const victim = batch[refusedAt] as EventEnvelope<unknown>;
        batch[refusedAt] = { ...victim, receivedAt: "not-an-instant" };
      }
      const sent = await publisher.publishBatch(stream, batch);
      published += sent.receipts.length;
      if (refusedAt !== undefined) {
        expect(sent.failure?.index, "the real transport refused the substituted envelope").toBe(refusedAt);
        expect(sent.receipts).toHaveLength(refusedAt);
        await step(1);
        break;
      }
      expect(sent.failure, `call ${String(index)} published whole`).toBeUndefined();
      const quiet = consumer.fault.kind === "retention-trim" && isLate;
      await step(quiet ? 0 : (consumer.pollsAfterCall[index % consumer.pollsAfterCall.length] ?? 1));
    }
    // Read to the end of what was published.
    for (let index = 0; index < 64 && !current.run.trader.halts.anyHalt; index += 1) {
      const polled = current.batches.length;
      await poll(current);
      pollsMade += 1;
      if (current.batches.length > polled && current.batches[current.batches.length - 1] === 0) break;
    }
  } finally {
    for (const traderProcess of processes) await stopProcess(traderProcess);
    await publisher.close();
  }
  let orders = 0;
  let approvals = 0;
  let staleBookPauses = 0;
  const halts: string[] = [];
  const batches: number[] = [];
  let framesSplit = 0;
  let readFailuresInjected = 0;
  for (const traderProcess of processes) {
    const health = traderProcess.run.trader.loop.health();
    orders += traderProcess.run.trader.loop.orderProvenance().length;
    approvals += health.risk.approvals;
    staleBookPauses += traderProcess.run.parts.store.decisions.filter((recorded) =>
      recorded.record.decision.reasonCodes.includes("SB.STALE_BOOK"),
    ).length;
    halts.push(...health.halts.map((halt) => halt.code));
    batches.push(...traderProcess.batches);
    framesSplit += traderProcess.feed.framesSplit;
    readFailuresInjected += traderProcess.readFailures.count;
  }
  return { orders, approvals, staleBookPauses, halts, batches, framesSplit, published, readFailuresInjected };
}

const NO_FAULT: GatewayFault = { kind: "none" };

function wholeFrame(noCount: number, yesAt: number | undefined, successor: boolean): GatewayShape {
  return { noCount, yesAt, maxQueueDepth: 4_096, backlog: false, successor, fault: NO_FAULT };
}

function reader(basis: Basis, receiveBatchSize: number, fault: ConsumerFault = { kind: "none" }): ConsumerShape {
  return { basis, receiveBatchSize, ingestDepth: Math.max(receiveBatchSize, 4_096), pollsAfterCall: [1], fault };
}

/** The late part of what the gateway published, flattened. */
function lateEnvelopes(gateway: GatewayOutput): EventEnvelope<unknown>[] {
  return gateway.calls.flat().filter((envelope) => Date.parse(envelope.receivedAt) >= LATE_MS);
}

function isIncident(envelope: EventEnvelope<unknown>, reasonCode: string): boolean {
  return (
    envelope.eventType === "DataQualityIncidentOpened" &&
    (envelope.payload as { reasonCode?: unknown }).reasonCode === reasonCode
  );
}

/**
 * Moves the first incident with `reasonCode` from AHEAD of its frame to just
 * after the frame's first accepted event, swapping their sequences so the
 * stream still advances: the order `74e17ca` (R6-H1) and `f341d5f` (X8)
 * published. The calls are rebuilt as one call per envelope from there on.
 */
function incidentAfterItsFrame(gateway: GatewayOutput, reasonCode: string): GatewayOutput {
  const flat = gateway.calls.flat();
  const at = flat.findIndex((envelope) => isIncident(envelope, reasonCode));
  if (at === -1) throw new Error(`no ${reasonCode} incident to move`);
  const incident = flat[at] as EventEnvelope<unknown>;
  const sibling = flat[at + 1] as EventEnvelope<unknown>;
  expect(sibling.causationId, "the incident is followed by its frame's first event").toBeDefined();
  const reordered = [
    ...flat.slice(0, at),
    { ...sibling, ingestSeq: incident.ingestSeq },
    { ...incident, ingestSeq: sibling.ingestSeq },
    ...flat.slice(at + 2),
  ];
  return { calls: reordered.map((envelope) => [envelope]), halts: gateway.halts };
}

/** Cuts the published stream just before the late frame's YES change: the prefix `2d29b2d` published. */
function prefixBeforeYes(gateway: GatewayOutput): GatewayOutput {
  const flat = gateway.calls.flat();
  const yes = flat.findIndex(
    (envelope) =>
      envelope.eventType === "BookSnapshot" &&
      (envelope.payload as { tokenId?: unknown }).tokenId === YES_TOKEN &&
      Date.parse(envelope.receivedAt) >= LATE_MS,
  );
  if (yes === -1) throw new Error("no late YES change to cut before");
  const kept = new Set(flat.slice(0, yes).map(identityOf));
  const calls = gateway.calls
    .map((call) => call.filter((envelope) => kept.has(identityOf(envelope))))
    .filter((call) => call.length > 0);
  return { calls, halts: gateway.halts };
}

// ---------------------------------------------------------------------------
// 1. Named regressions: each round's published shape, through Redis
// ---------------------------------------------------------------------------

describe("THROUGHPUT-1c r8 — named regressions: every round's cut frame, through Redis, the real feed and the real pump", () => {
  for (const [receiveBatchSize, noCount] of [
    [128, 128],
    [128, 199],
    [128, 1_023],
    [1, 1],
  ] as const) {
    it(`R8-H1: receiveBatchSize ${String(receiveBatchSize)}, a frame of ${String(noCount + 1)} events (its YES change last) published whole and read in parts admits nothing (2 at 298199d)`, async () => {
      const gateway = await gatewayRun(wholeFrame(noCount, noCount, false));
      expect(gateway.halts).toEqual([]);
      // Published whole, in ONE transport call (the gateway's stop follows in its own).
      const frameCalls = gateway.calls.filter((call) => call.some((envelope) => envelope.eventType === "BookSnapshot" && Date.parse(envelope.receivedAt) >= LATE_MS));
      expect(frameCalls.map((call) => call.length)).toEqual([noCount + 1]);
      const confirmed = await trade(gateway, reader("CONNECTION_CONFIRMED", receiveBatchSize));
      const lastChange = await trade(gateway, reader("LAST_CHANGE", receiveBatchSize));
      // The feed DID hand the frame out in parts.
      expect(confirmed.framesSplit).toBeGreaterThan(0);
      expect([confirmed.orders, lastChange.orders], "orders on a book whose change was in the unread part").toEqual([0, 0]);
      expect([confirmed.approvals, lastChange.approvals]).toEqual([0, 0]);
      expect(confirmed.staleBookPauses).toBeGreaterThan(0);
      expect(confirmed.halts).toEqual([]);
    });
  }

  it("R8-H1 with a successor: the frame read in parts is proven only after its YES change is applied, and admits nothing (2 at 298199d)", async () => {
    const gateway = await gatewayRun(wholeFrame(128, 128, true));
    const confirmed = await trade(gateway, reader("CONNECTION_CONFIRMED", 128));
    expect([confirmed.orders, confirmed.approvals]).toEqual([0, 0]);
    expect(confirmed.framesSplit).toBeGreaterThan(0);
  });

  it("R7-H1 at the consumer: the stream ends on a frame's prefix (what 2d29b2d published behind a backlog outage), read in one short read: nothing admitted (2 at 298199d)", async () => {
    const whole = await gatewayRun(wholeFrame(899, 899, false));
    const cut = prefixBeforeYes(whole);
    expect(lateEnvelopes(cut).filter((envelope) => envelope.eventType === "BookSnapshot")).toHaveLength(899);
    const confirmed = await trade(cut, reader("CONNECTION_CONFIRMED", 4_096));
    // One short read handed the whole prefix out "whole".
    expect(confirmed.framesSplit).toBe(0);
    expect([confirmed.orders, confirmed.approvals], "orders on a book whose change was in the lost tail").toEqual([0, 0]);
  });

  it("R7-H1's remaining case: the REAL Redis transport refuses an envelope inside the frame's call and publishes its prefix: nothing admitted (2 at 298199d)", async () => {
    const gateway = await gatewayRun(wholeFrame(600, 600, false));
    const confirmed = await trade(gateway, reader("CONNECTION_CONFIRMED", 4_096, { kind: "transport-refusal", at: 600 }));
    expect(confirmed.published).toBeGreaterThan(600);
    expect([confirmed.orders, confirmed.approvals]).toEqual([0, 0]);
  });

  it("R6-H1 at the consumer: the refused envelope's incident FOLLOWS its frame's accepted NO snapshot (what 74e17ca published): nothing admitted (2 at 298199d)", async () => {
    const current = await gatewayRun({ ...wholeFrame(1, undefined, false), fault: { kind: "envelope-refused", at: 1 } });
    const late = lateEnvelopes(current);
    expect(late.findIndex((envelope) => isIncident(envelope, "GATEWAY_ENVELOPE_REJECTED"))).toBe(0);
    const old = incidentAfterItsFrame(current, "GATEWAY_ENVELOPE_REJECTED");
    const oldLate = lateEnvelopes(old);
    expect(oldLate[0]?.eventType).toBe("BookSnapshot");
    expect(isIncident(oldLate[1] as EventEnvelope<unknown>, "GATEWAY_ENVELOPE_REJECTED")).toBe(true);
    const confirmed = await trade(old, reader("CONNECTION_CONFIRMED", 4_096));
    expect([confirmed.orders, confirmed.approvals], "orders after the gateway refused a YES update").toEqual([0, 0]);
  });

  it("X8 at the consumer: a partly malformed frame's incident FOLLOWS its accepted NO snapshot (what f341d5f published): nothing admitted (2 at 298199d)", async () => {
    const current = await gatewayRun({ ...wholeFrame(1, undefined, false), fault: { kind: "malformed", at: 0 } });
    const old = incidentAfterItsFrame(current, "UNKNOWN_SIDE");
    const confirmed = await trade(old, reader("CONNECTION_CONFIRMED", 4_096));
    expect([confirmed.orders, confirmed.approvals], "orders after a frame lost a YES update").toEqual([0, 0]);
  });

  it("the trigger of the R6 shape is real: the refused change's ISO form has a five-digit year", () => {
    const iso = new Date(253_402_300_800_000).toISOString();
    expect(IsoTimestampSchema.safeParse(iso).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Controls: the harness can observe a vouch, at every receiveBatchSize
// ---------------------------------------------------------------------------

describe("THROUGHPUT-1c r8 — controls: a whole frame proven by its successor DOES vouch, at every receiveBatchSize", () => {
  for (const [receiveBatchSize, noCount] of [
    [1, 2],
    [2, 129],
    [128, 129],
    [128, 1_024],
    [4_096, 1],
  ] as const) {
    it(`receiveBatchSize ${String(receiveBatchSize)}, a frame of ${String(noCount)} NO snapshots and a successor: entry under CONNECTION_CONFIRMED only`, async () => {
      const gateway = await gatewayRun(wholeFrame(noCount, undefined, true));
      const confirmed = await trade(gateway, reader("CONNECTION_CONFIRMED", receiveBatchSize));
      const lastChange = await trade(gateway, reader("LAST_CHANGE", receiveBatchSize));
      expect(confirmed.orders, JSON.stringify(confirmed.batches)).toBeGreaterThan(0);
      expect(confirmed.approvals).toBeGreaterThan(0);
      expect(lastChange.orders).toBe(0);
    });
  }

  it("without the successor the same frame never vouches: the cost of the rule, stated", async () => {
    const gateway = await gatewayRun(wholeFrame(129, undefined, false));
    const confirmed = await trade(gateway, reader("CONNECTION_CONFIRMED", 4_096));
    expect([confirmed.orders, confirmed.approvals]).toEqual([0, 0]);
    expect(confirmed.staleBookPauses).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 3. The seeded property, per boundary
// ---------------------------------------------------------------------------

/** `mulberry32`: a small, seeded, reproducible generator. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(random: () => number, values: readonly T[]): T {
  return values[Math.floor(random() * values.length)] as T;
}

function between(random: () => number, low: number, high: number): number {
  return low + Math.floor(random() * (high - low + 1));
}

/**
 * Frame lengths from 1 to twice the one-call limit: the limits' neighbours,
 * then anything up to the limit, then anything past it (where the gateway's
 * `GATEWAY_FRAME_SPLIT` taint applies).
 */
function frameLength(random: () => number): number {
  const draw = random();
  if (draw < 0.4) return pick(random, [1, 2, 3, 127, 128, 129, 200, 1_023, 1_024, 1_025, 2_048]);
  if (draw < 0.75) return between(random, 1, ONE_CALL);
  return between(random, ONE_CALL + 1, 2 * ONE_CALL);
}

/** `receiveBatchSize` from 1 upward, the example's 128 and its neighbours weighted in. */
function receiveBatchSize(random: () => number): number {
  return random() < 0.6 ? pick(random, [1, 2, 3, 64, 127, 128, 129, 1_024, 4_096]) : between(random, 1, 2_100);
}

type Boundary =
  | "feed batching and carry (no failure)"
  | "transport call: an outage between calls"
  | "envelope validation: a refused envelope"
  | "adapter parse: a malformed entry"
  | "WAL: the raw frame refused"
  | "Redis XADD: the real transport refuses mid-call"
  | "restart: a new process resumes from the committed position"
  | "Redis XREAD: a read fails"
  | "retention trim";

interface PropertyCase {
  readonly label: string;
  readonly gateway: GatewayShape;
  readonly consumer: ConsumerShape;
}

function propertyCase(boundary: Boundary, random: () => number, index: number): PropertyCase {
  // A trim must remove something the trader has not read: more than 16 late events.
  const drawn = Math.max(1, frameLength(random));
  const total = boundary === "retention trim" ? Math.max(drawn, 64) : drawn;
  // The frame's YES change: at a random place, the last entry (the place a
  // cut is likeliest to leave unread) weighted in.
  const yesAt = random() < 0.5 ? total - 1 : between(random, 0, total - 1);
  const noCount = Math.max(0, total - 1);
  const size = receiveBatchSize(random);
  let gatewayFault: GatewayFault = NO_FAULT;
  let consumerFault: ConsumerFault = { kind: "none" };
  let backlog = random() < 0.25;
  let successor = random() < 0.6;
  let maxQueueDepth = pick(random, [1_024, 2_048, 4_096, 16_384]);
  switch (boundary) {
    case "feed batching and carry (no failure)":
      break;
    case "transport call: an outage between calls":
      gatewayFault = { kind: "outage", call: between(random, 0, backlog ? 3 : 2) };
      break;
    case "envelope validation: a refused envelope":
      gatewayFault = { kind: "envelope-refused", at: between(random, 0, total) };
      break;
    case "adapter parse: a malformed entry":
      gatewayFault = { kind: "malformed", at: between(random, 0, total) };
      break;
    case "WAL: the raw frame refused":
      gatewayFault = { kind: "wal-refused" };
      backlog = false;
      break;
    case "Redis XADD: the real transport refuses mid-call":
      consumerFault = { kind: "transport-refusal", at: between(random, 0, Math.min(total, ONE_CALL) - 1) };
      maxQueueDepth = 16_384;
      break;
    case "restart: a new process resumes from the committed position":
      consumerFault = { kind: "restart", afterPolls: between(random, 1, 8) };
      break;
    case "Redis XREAD: a read fails":
      consumerFault = { kind: "read-failure", atRead: between(random, 2, 8) };
      break;
    case "retention trim":
      consumerFault = { kind: "retention-trim" };
      successor = true;
      backlog = false;
      break;
  }
  const ingestDepth = random() < 0.3 ? size : pick(random, [4_096, 16_384]);
  const pollsAfterCall = Array.from({ length: 4 }, () => between(random, 0, 2));
  // Every third case also runs under LAST_CHANGE (the basis the property can
  // never fail under, kept as the baseline).
  const basis: Basis = index % 3 === 2 ? "LAST_CHANGE" : "CONNECTION_CONFIRMED";
  return {
    label: `frame ${String(total)} (YES at ${String(yesAt)}), receive ${String(size)}, ingest ${String(ingestDepth)}, admission ${String(maxQueueDepth)}, backlog ${String(backlog)}, successor ${String(successor)}, polls ${JSON.stringify(pollsAfterCall)}, ${basis}, gateway ${JSON.stringify(gatewayFault)}, consumer ${JSON.stringify(consumerFault)}`,
    gateway: { noCount, yesAt, maxQueueDepth, backlog, successor, fault: gatewayFault },
    consumer: { basis, receiveBatchSize: size, ingestDepth, pollsAfterCall, fault: consumerFault },
  };
}

const PROPERTY_SEED = 0x7c_0008;
const CASES_PER_BOUNDARY = 10;

const BOUNDARIES: readonly Boundary[] = [
  "feed batching and carry (no failure)",
  "transport call: an outage between calls",
  "envelope validation: a refused envelope",
  "adapter parse: a malformed entry",
  "WAL: the raw frame refused",
  "Redis XADD: the real transport refuses mid-call",
  "restart: a new process resumes from the committed position",
  "Redis XREAD: a read fails",
  "retention trim",
];

describe("THROUGHPUT-1c r8 — the property: no order or approval on a book whose latest change sits in a part of a frame the trader has not applied", () => {
  for (const [boundaryIndex, boundary] of BOUNDARIES.entries()) {
    it(`${boundary}: ${String(CASES_PER_BOUNDARY)} seeded cases`, async () => {
      const random = generator(PROPERTY_SEED + boundaryIndex);
      const violations: string[] = [];
      for (let index = 0; index < CASES_PER_BOUNDARY; index += 1) {
        const property = propertyCase(boundary, random, index);
        const gateway = await gatewayRun(property.gateway);
        const outcome = await trade(gateway, property.consumer);
        if (outcome.orders !== 0 || outcome.approvals !== 0) {
          violations.push(
            `${property.label}: orders ${String(outcome.orders)}, approvals ${String(outcome.approvals)}, batches ${JSON.stringify(outcome.batches.slice(0, 12))}`,
          );
        }
        // Each injected failure did what it says, where it can be observed.
        if (outcome.readFailuresInjected > 0) {
          expect(outcome.halts, property.label).toContain("TRANSPORT_UNAVAILABLE");
        }
        if (property.consumer.fault.kind === "retention-trim") {
          expect(outcome.halts, property.label).toContain("TRANSPORT_RESYNC_REQUIRED");
        }
        if (property.gateway.fault.kind === "wal-refused") {
          expect(
            lateEnvelopes(gateway).some((envelope) => isIncident(envelope, "GATEWAY_WAL_FRAME_REFUSED")),
            property.label,
          ).toBe(true);
        }
      }
      expect(violations, "cases that admitted an order or an approval").toEqual([]);
    }, 300_000);
  }
});
