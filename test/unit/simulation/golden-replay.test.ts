/**
 * The golden replay (§12.4: "CI runs a small golden replay on every change to
 * core contracts").
 *
 * The fixture is `test/replay-golden/simulation/golden-replay.json`; its
 * provenance and the derivation of every expected line are in the README beside
 * it. The expected serialization is written out as literal lines in the FIXTURE,
 * derived by hand from `serializeRun`'s published grammar and the fixture's own
 * inputs — not captured from a run. A change to the format, the ordering, the
 * clock accounting, or the reconciliation counters moves these bytes, and moving
 * them requires re-deriving them.
 *
 * The suite also asserts the two things a golden test is for beyond its own
 * bytes: the run is reproducible (same bytes twice) and it is SENSITIVE (a
 * one-character change to the dataset changes the bytes).
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SimulatedVenue,
  deriveReplayEventId,
  deriveStreams,
  readDatasetManifestText,
  runReplay,
  simulationOk,
  tier1Model,
  unmodeledRateLimits,
  type ArchivedObject,
  type BookLevelView,
  type BookView,
  type DatasetArchiveReader,
  type ExecutionPolicy,
  type FeeScheduleSnapshot,
  type LatencyModel,
  type NormalizeOutcome,
  type PlacementPlanView,
  type QueueModelParameters,
  type RecordedEventIdentity,
  type ReplayNormalizer,
  type ReplayRecord,
  type ReplayRunPins,
  type Sha256HexDigest,
} from "../../../packages/simulation/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "test", "replay-golden", "simulation", "golden-replay.json");

const sha256Hex: Sha256HexDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

interface GoldenFixture {
  readonly manifest: unknown;
  readonly rows: readonly unknown[];
  readonly runPins: ReplayRunPins;
  readonly expected: { readonly serialization: readonly string[] };
}

function loadFixture(): GoldenFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenFixture;
}

/**
 * The golden normalizer.
 *
 * It performs the one interpretation the golden replay needs — surfacing the
 * venue's own `timestamp` as the envelope's `venueTimestamp` — and copies every
 * provenance field verbatim. Its version matches the fixture's run pin.
 */
function goldenNormalizer(): ReplayNormalizer {
  return {
    normalizerVersion: "golden/market-frame/v1",
    normalize(record: ReplayRecord): NormalizeOutcome {
      let venueTimestamp: string | undefined;
      let eventType = "MarketFrame";
      try {
        const parsed = JSON.parse(record.frame.payloadUtf8) as {
          timestamp?: unknown;
          event_type?: unknown;
        };
        if (typeof parsed.timestamp === "string") {
          venueTimestamp = new Date(Number(parsed.timestamp)).toISOString();
        }
        if (typeof parsed.event_type === "string") eventType = parsed.event_type;
      } catch {
        return { ok: false, reason: "the recorded payload is not JSON" };
      }
      const eventId = deriveReplayEventId(sha256Hex, {
        gatewayEpoch: record.frame.gatewayEpoch,
        ingestSeq: record.frame.ingestSeq,
        receivedAt: record.frame.receivedAt,
        index: 0,
      });
      if (!eventId.ok) return { ok: false, reason: eventId.refusal.message };
      return {
        ok: true,
        envelopes: [
          {
            eventId: eventId.value,
            eventType,
            schemaVersion: 1,
            source: "polymarket",
            sourceChannel: "market",
            ...(venueTimestamp === undefined ? {} : { venueTimestamp }),
            receivedAt: record.frame.receivedAt,
            receivedMonotonicNs: record.frame.receivedMonotonicNs,
            gatewayEpoch: record.frame.gatewayEpoch,
            ingestSeq: record.frame.ingestSeq,
            payload: record.frame.payloadUtf8,
          },
        ],
      };
    },
  };
}

function archiveOf(fixture: GoldenFixture, rows: readonly unknown[] = fixture.rows): DatasetArchiveReader {
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(rows), "utf8"));
  return {
    async readObject(objectKey: string): Promise<ArchivedObject> {
      return await Promise.resolve({ objectKey, bytes, rows });
    },
  };
}

// ---------------------------------------------------------------------------
// The golden run's simulated venue
// ---------------------------------------------------------------------------
//
// The golden replay drives a TIER-1 venue through the §12.1 seam, so the pinned
// bytes cover what §12.4 actually lists — simulated order events, fills and the
// economics they produce — rather than an all-zero run. Everything it needs is
// declared here and is deterministic: the latency distributions have one sample
// each at 0 ms, so the sampled latency is 0 whatever the seed draws, and the
// book is the one the recorded `book` frame carries.

const GOLDEN_MARKET_ID = "0x1234";
const GOLDEN_TOKEN_ID = "7134526469571836016";

const GOLDEN_FEES: FeeScheduleSnapshot = {
  snapshotVersion: "fees/2026-08-24",
  takerFeeRate: "0.07",
  makerFeeRate: "0",
  roundingDecimalPlaces: 5,
  roundingMode: "HALF_UP",
  minimumChargedFee: "0.00001",
  feeCurrency: "USDC",
};

const GOLDEN_LATENCY: LatencyModel = {
  latencyModelVersion: "sim/latency/v1",
  decision: { samples: [{ milliseconds: 0, weight: 1 }] },
  signing: { samples: [{ milliseconds: 0, weight: 1 }] },
  network: { samples: [{ milliseconds: 0, weight: 1 }] },
  venue: { samples: [{ milliseconds: 0, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

const GOLDEN_QUEUE: QueueModelParameters = {
  queueModelVersion: "sim/queue/v1",
  cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
  cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
  placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

const GOLDEN_POLICY: ExecutionPolicy = {
  timeInForceFor: () => "GTC",
  statedExpiryNsFor: () => undefined,
  sameInstantAdditionsSharesFor: () => "0",
};

function bookView(bids: readonly BookLevelView[], asks: readonly BookLevelView[]): BookView {
  return {
    internalMarketId: GOLDEN_MARKET_ID,
    tokenId: GOLDEN_TOKEN_ID,
    top: () => ({
      ...(bids[0] === undefined ? {} : { bestBidPrice: bids[0].price, bestBidSize: bids[0].size }),
      ...(asks[0] === undefined ? {} : { bestAskPrice: asks[0].price, bestAskSize: asks[0].size }),
    }),
    ladder: (side) => (side === "ASK" ? asks : bids),
  };
}

/** The plan the golden run submits when the recorded `book` frame arrives. */
function goldenPlan(): PlacementPlanView {
  return {
    executionPlanId: "golden-plan-1",
    strategyInstanceId: "golden-instance-1",
    runMode: "BACKTEST",
    plannedAt: "2026-06-29T17:15:57.300Z",
    deadline: "2026-06-29T17:16:57.300Z",
    planKind: "POSITION",
    priority: "PLACEMENT",
    priceProtection: { mode: "CAPPED_LIMIT_ORDERS_ONLY" },
    escalation: { atDeadline: "CANCEL_REMAINING" },
    partialFill: { policy: "ACCEPT_ANY" },
    groups: [
      {
        executionGroupId: "golden-group-1",
        marketId: GOLDEN_MARKET_ID,
        tickSize: "0.01",
        minimumOrderSize: "5",
        orders: [
          {
            // Crosses the recorded 0.09 ask: it takes.
            plannedOrderId: "golden-order-take",
            marketId: GOLDEN_MARKET_ID,
            side: "YES",
            action: "BUY",
            limitPrice: "0.09",
            shares: "10",
            postOnly: false,
            executionStyle: "MARKETABLE_LIMIT",
            reservationId: "golden-res-1",
          },
          {
            // Inside the recorded spread: it rests, and its estimate is a BAND.
            plannedOrderId: "golden-order-rest",
            marketId: GOLDEN_MARKET_ID,
            side: "YES",
            action: "BUY",
            limitPrice: "0.08",
            shares: "50",
            postOnly: true,
            executionStyle: "REST",
            reservationId: "golden-res-2",
          },
        ],
      },
    ],
  };
}

interface RecordedTrade {
  readonly price: string;
  readonly shares: string;
}

/** The trade a `last_trade_price` frame carries, or `undefined` for other frames. */
function recordedTrade(payloadUtf8: string): RecordedTrade | undefined {
  const parsed = JSON.parse(payloadUtf8) as {
    event_type?: unknown;
    price?: unknown;
    size?: unknown;
  };
  if (parsed.event_type !== "last_trade_price") return undefined;
  if (typeof parsed.price !== "string" || typeof parsed.size !== "string") return undefined;
  return { price: parsed.price, shares: parsed.size };
}

async function replay(fixture: GoldenFixture, rows?: readonly unknown[]) {
  const dataset = readDatasetManifestText(`${JSON.stringify(fixture.manifest, null, 2)}\n`);
  if (!dataset.ok) throw new Error(`golden manifest refused: ${dataset.refusal.message}`);

  // The book the recorded `book` frame carries, and the recorded event it was
  // observed at. Both are set by the core loop from the delivered event, so
  // nothing here can see a book the replay had not reached (§6 invariant 15).
  let observedBook: { book: BookView; atEvent: RecordedEventIdentity } | undefined;
  let planRefusal: string | undefined;

  // The venue's clock is positioned by the RECORDED event the driver is at, and
  // by nothing else — the same instant `runReplay` advanced the source's clock
  // to before delivering the event (§12.1: the venue reads no clock of its own).
  let atIso = "";
  let atNs = 0n;

  const venue = new SimulatedVenue({
    clock: { now: () => atIso, monotonicNs: () => atNs },
    runMode: "BACKTEST",
    model: tier1Model({
      fillModelVersion: fixture.runPins.fillModelVersion,
      fillModelParametersHash: fixture.runPins.fillModelParametersHash,
    }),
    feeSnapshot: GOLDEN_FEES,
    rateLimits: unmodeledRateLimits(
      "the golden replay wires no venue budget model; ADR-012 §5.6 requires that absence to be stated",
    ),
    policy: GOLDEN_POLICY,
    startingCash: "1000",
    timeline: { bookAt: () => observedBook },
    latencyModel: GOLDEN_LATENCY,
    streams: deriveStreams(fixture.runPins.runSeed),
    marketParameters: (marketId) =>
      marketId === GOLDEN_MARKET_ID
        ? {
            marketId: GOLDEN_MARKET_ID,
            tickSize: "0.01",
            minimumOrderSize: "5",
            secondsDelay: 0,
            parametersVersion: 1,
          }
        : undefined,
    queueParameters: GOLDEN_QUEUE,
  });

  const result = await runReplay({
    dataset: dataset.value,
    archive: archiveOf(fixture, rows),
    digestSha256: sha256Hex,
    normalizer: goldenNormalizer(),
    runPins: fixture.runPins,
    venue,
    coreLoop: async (context) => {
      atIso = context.record.frame.receivedAt;
      atNs = context.monotonicNs;
      const payload = context.record.frame.payloadUtf8;
      if (context.envelope.eventType === "book") {
        observedBook = {
          book: bookView([{ price: "0.07", size: "100" }], [{ price: "0.09", size: "60" }]),
          atEvent: context.identity,
        };
        const submitted = await venue.submit(goldenPlan());
        if (!submitted.accepted) {
          planRefusal = `${String(submitted.refusalCode)}: ${String(submitted.refusalMessage)}`;
        }
        return simulationOk(null);
      }
      const trade = recordedTrade(payload);
      if (trade !== undefined) {
        const observed = venue.observeTrade({
          marketId: GOLDEN_MARKET_ID,
          side: "YES",
          price: trade.price,
          shares: trade.shares,
          monotonicNs: context.monotonicNs,
          atEvent: context.identity,
        });
        if (!observed.ok) return observed;
      }
      return simulationOk(null);
    },
  });
  if (planRefusal !== undefined) throw new Error(`golden plan refused: ${planRefusal}`);
  return result;
}

describe("the golden replay", () => {
  it("produces exactly the pinned bytes", async () => {
    const fixture = loadFixture();
    const result = await replay(fixture);
    expect(result.ok, result.ok ? "" : `${result.refusal.code}: ${result.refusal.message}`).toBe(true);
    if (!result.ok) return;
    expect(result.value.serialization.split("\n")).toEqual([...fixture.expected.serialization]);
    expect(result.value.serialization).toBe(fixture.expected.serialization.join("\n"));
  });

  it("delivers the recorded dispatch order, which is NOT the venue-timestamp order", async () => {
    const fixture = loadFixture();
    const result = await replay(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventsDelivered).toBe(3);
    // The fixture's venue timestamps are 1782753357257, …357000, …357500 — so
    // venue-time order is (4, 1, 9) and dispatch order is (1, 4, 9). The count
    // is over the DELIVERED envelopes' `venueTimestamp`, which is the field
    // §8.4 is about; the arrival-clock disagreement is a separate counter.
    expect(result.value.delivery.venueTimestampInversions).toBe(1);
    expect(result.value.load.receivedAtInversions).toBe(1);
  });

  it("pins a run that actually TRADED — the §12.4 list is exercised, not skipped", async () => {
    // The previous golden drove no venue at all, so its pinned bytes carried
    // zero orders, zero fills and zero economics: the §12.4 byte-identity list
    // was unexercised by the very test that exists to guard it. This asserts
    // the golden stays non-degenerate.
    const fixture = loadFixture();
    const result = await replay(fixture);
    expect(result.ok, result.ok ? "" : `${result.refusal.code}: ${result.refusal.message}`).toBe(true);
    if (!result.ok) return;
    expect(result.value.orders).toHaveLength(2);
    expect(result.value.fills).toHaveLength(1);
    expect(result.value.bands).toHaveLength(1);
    expect(result.value.economics.fillCount).toBe(1);
    expect(result.value.economics.netCashFlow).not.toBe("0");
    // The resting order's estimate is the BAND, and the order says so.
    const resting = result.value.orders.find((order) => order.executionStyle === "REST");
    expect(resting?.state).toBe("RESTING");
    expect(resting?.fillEstimateKind).toBe("TIER_1_RESTING_BAND");
    expect(result.value.bands[0]?.base.filledShares).toBe("5");
  });

  it("is reproducible: two runs are byte-identical", async () => {
    const fixture = loadFixture();
    const first = await replay(fixture);
    const second = await replay(fixture);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.serialization).toBe(first.value.serialization);
  });

  it("is SENSITIVE: changing one recorded byte changes the outcome", async () => {
    const fixture = loadFixture();
    const rows = JSON.parse(JSON.stringify(fixture.rows)) as {
      record: { payloadUtf8: string; payloadSha256: string };
    }[];
    const target = rows[1];
    if (target !== undefined) {
      target.record.payloadUtf8 = target.record.payloadUtf8.replace('"0.08"', '"0.09"');
    }
    const result = await replay(fixture, rows);
    // The per-record checksum catches it before the ordering does: the
    // manifest's own pins are the trust boundary (§8.4).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["REPLAY_OBJECT_CHECKSUM_MISMATCH", "REPLAY_SEGMENT_CHECKSUM_MISMATCH"]).toContain(
      result.refusal.code,
    );
  });

  it("refuses a run whose §12.5 pins are incomplete", async () => {
    const fixture = loadFixture();
    const dataset = readDatasetManifestText(`${JSON.stringify(fixture.manifest, null, 2)}\n`);
    expect(dataset.ok).toBe(true);
    if (!dataset.ok) return;
    const result = await runReplay({
      dataset: dataset.value,
      archive: archiveOf(fixture),
      digestSha256: sha256Hex,
      normalizer: goldenNormalizer(),
      runPins: { ...fixture.runPins, fillModelVersion: "" },
    });
    expect(result.ok).toBe(false);
  });
});
