/**
 * WP-210 acceptance 2: **the same manifest/config/seed is byte-identical**
 * (§12.4, ADR-012 §4).
 *
 * Three independent things are measured, because they fail for different reasons:
 *
 * 1. **Across runs.** Two runs of the same dataset, config and seed produce the
 *    same serialization bytes.
 * 2. **Across CONSTRUCTION ORDERS.** The same inputs built in a different order —
 *    object keys permuted, collections shuffled — produce the same bytes. This
 *    is what catches a serializer that emits from `Object.keys` order or a `Map`
 *    that is iterated in insertion order.
 * 3. **Against INDEPENDENT ORACLES.** The seeded generator is re-implemented in
 *    the test from its three published constants, and the serialization is
 *    re-derived by a different primitive (a field-by-field rebuild) rather than
 *    by calling the implementation twice. A test that compares an implementation
 *    with itself proves only that it is a function.
 */

import { describe, expect, it } from "vitest";

import {
  SEEDED_STREAM_LABELS,
  SIMULATION_RUN_SERIALIZATION_VERSION,
  deriveStream,
  deriveStreams,
  readDatasetManifestText,
  runReplay,
  sampleLatency,
  serializeRun,
  simulateResting,
  simulatedFill,
  tier1Model,
  type LatencyModel,
  type RestingFillBand,
  type SimulatedOrder,
} from "../../../packages/simulation/src/index.js";

import {
  OUT_OF_ORDER_VENUE_FRAMES,
  buildDataset,
  runPins,
  sha256Hex,
  venueTimestampNormalizer,
} from "./fixtures.js";

// ---------------------------------------------------------------------------
// The independent SplitMix64 oracle
// ---------------------------------------------------------------------------

/**
 * SplitMix64, re-implemented from its published constants.
 *
 * Deliberately written from the algorithm rather than imported, so it is an
 * ORACLE: if `packages/simulation`'s generator drifts by one constant or one
 * shift, this disagrees. The stream-derivation step is mirrored the same way.
 */
const MASK = (1n << 64n) - 1n;
function oracleMix(value: bigint): bigint {
  let z = value & MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
  return (z ^ (z >> 31n)) & MASK;
}
function oracleStream(seed: string, label: string): () => bigint {
  let state = oracleMix(BigInt(seed) & MASK);
  state = (state ^ oracleMix(BigInt(label.length))) & MASK;
  for (let index = 0; index < label.length; index += 1) {
    state = oracleMix((state + BigInt(label.charCodeAt(index)) + 0x9e3779b97f4a7c15n) & MASK);
  }
  return () => {
    state = (state + 0x9e3779b97f4a7c15n) & MASK;
    return oracleMix(state);
  };
}

describe("the seeded generator matches an independently written oracle", () => {
  it("agrees for 200 draws on each named stream", () => {
    for (const label of SEEDED_STREAM_LABELS) {
      const mine = deriveStream("42", label);
      const oracle = oracleStream("42", label);
      for (let index = 0; index < 200; index += 1) {
        expect(mine.nextUint64(), `${label} draw ${String(index)}`).toBe(oracle());
      }
    }
  });

  it("two different seeds give different sequences, and the same seed the same", () => {
    expect(deriveStream("1", "latency.network").nextUint64()).not.toBe(
      deriveStream("2", "latency.network").nextUint64(),
    );
    expect(deriveStream("7", "latency.network").nextUint64()).toBe(
      deriveStream("7", "latency.network").nextUint64(),
    );
  });

  it("named streams are independent of each other", () => {
    const first = deriveStreams("42");
    const second = deriveStreams("42");
    // Drawing heavily from one stream does not move another.
    for (let index = 0; index < 50; index += 1) first["latency.decision"].nextUint64();
    expect(first["latency.network"].nextUint64()).toBe(second["latency.network"].nextUint64());
  });

  it("nextBelow is unbiased over a bound that does not divide 2^64", () => {
    // 3 does not divide 2^64, so a plain `% 3` would over-weight 0 and 1. Over
    // 30,000 draws the counts must be within a few percent of each other.
    const stream = deriveStream("99", "latency.network");
    const counts = [0, 0, 0];
    for (let index = 0; index < 30_000; index += 1) {
      const draw = Number(stream.nextBelow(3n));
      counts[draw] = (counts[draw] ?? 0) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(9_000);
      expect(count).toBeLessThan(11_000);
    }
  });
});

// ---------------------------------------------------------------------------
// Latency sampling
// ---------------------------------------------------------------------------

const LATENCY_MODEL: LatencyModel = {
  latencyModelVersion: "sim/latency/v1",
  decision: { samples: [{ milliseconds: 1, weight: 3 }, { milliseconds: 5, weight: 1 }] },
  signing: { samples: [{ milliseconds: 2, weight: 1 }] },
  network: { samples: [{ milliseconds: 10, weight: 2 }, { milliseconds: 40, weight: 1 }] },
  venue: { samples: [{ milliseconds: 3, weight: 1 }] },
  basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
};

describe("latency sampling is a pure function of the seed", () => {
  it("gives the same sequence for the same seed and a different one for another", () => {
    const a = deriveStreams("42");
    const b = deriveStreams("42");
    const c = deriveStreams("43");
    const first: string[] = [];
    const second: string[] = [];
    const third: string[] = [];
    for (let index = 0; index < 20; index += 1) {
      first.push(JSON.stringify(sampleLatency(LATENCY_MODEL, a)));
      second.push(JSON.stringify(sampleLatency(LATENCY_MODEL, b)));
      third.push(JSON.stringify(sampleLatency(LATENCY_MODEL, c)));
    }
    expect(first).toEqual(second);
    expect(first).not.toEqual(third);
  });

  it("respects the declared weights", () => {
    const streams = deriveStreams("2026");
    const counts = new Map<number, number>();
    for (let index = 0; index < 12_000; index += 1) {
      const sampled = sampleLatency(LATENCY_MODEL, streams);
      counts.set(sampled.decisionMs, (counts.get(sampled.decisionMs) ?? 0) + 1);
    }
    // weights 3:1 over {1ms, 5ms}
    const ones = counts.get(1) ?? 0;
    const fives = counts.get(5) ?? 0;
    expect(ones + fives).toBe(12_000);
    expect(ones / fives).toBeGreaterThan(2.6);
    expect(ones / fives).toBeLessThan(3.4);
  });
});

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function manifestOf(text: string) {
  const dataset = readDatasetManifestText(text);
  if (!dataset.ok) throw new Error(`fixture manifest is invalid: ${dataset.refusal.message}`);
  return dataset.value;
}

async function replay(fixture: ReturnType<typeof buildDataset>) {
  const result = await runReplay({
    dataset: manifestOf(fixture.manifestText),
    archive: fixture.archive,
    digestSha256: sha256Hex,
    normalizer: venueTimestampNormalizer(),
    runPins: runPins(),
  });
  if (!result.ok) throw new Error(`replay refused: ${result.refusal.code} ${result.refusal.message}`);
  return result.value;
}

describe("acceptance 2 — the same manifest/config/seed is byte-identical", () => {
  it("is byte-identical across runs", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const first = await replay(fixture);
    const second = await replay(fixture);
    expect(second.serialization).toBe(first.serialization);
    expect(first.serialization.startsWith(SIMULATION_RUN_SERIALIZATION_VERSION)).toBe(true);
  });

  it("is byte-identical across CONSTRUCTION ORDERS of the same inputs", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const baseline = await replay(fixture);

    // The same run pins, built with their keys in a different order and with the
    // settlement-spec list reversed. Nothing about the RUN changed.
    const shuffledPins = {
      simulatorVersion: "wp-210/v1",
      settlementSpecVersions: ["b", "a"],
      rewardSnapshotVersion: "rewards/2026-08-24",
      feeSnapshotVersion: "fees/2026-08-24",
      latencyModelParametersHash: "1".repeat(64),
      latencyModelVersion: "sim/latency/v1",
      fillModelParametersHash: "0".repeat(64),
      fillModelVersion: "sim/tier0/v1",
      runSeed: "42",
      featureSetVersion: "features-v1",
      normalizerVersion: "test/venue-ts/v1",
    };
    const orderedPins = runPins({ settlementSpecVersions: ["a", "b"] });

    const shuffled = await runReplay({
      dataset: manifestOf(fixture.manifestText),
      archive: fixture.archive,
      digestSha256: sha256Hex,
      normalizer: venueTimestampNormalizer(),
      runPins: shuffledPins,
    });
    const ordered = await runReplay({
      dataset: manifestOf(fixture.manifestText),
      archive: fixture.archive,
      digestSha256: sha256Hex,
      normalizer: venueTimestampNormalizer(),
      runPins: orderedPins,
    });
    expect(shuffled.ok).toBe(true);
    expect(ordered.ok).toBe(true);
    if (!shuffled.ok || !ordered.ok) return;
    expect(shuffled.value.serialization).toBe(ordered.value.serialization);
    // …and it differs from the baseline only in the settlement pin it declares.
    expect(shuffled.value.serialization).not.toBe(baseline.serialization);
    expect(shuffled.value.serialization.replace("settlement=a,b", "settlement=")).toBe(
      baseline.serialization,
    );
  });

  it("changing the SEED changes the pinned run line and nothing silently", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const base = await replay(fixture);
    const reseeded = await runReplay({
      dataset: manifestOf(fixture.manifestText),
      archive: fixture.archive,
      digestSha256: sha256Hex,
      normalizer: venueTimestampNormalizer(),
      runPins: runPins({ runSeed: "43" }),
    });
    expect(reseeded.ok).toBe(true);
    if (!reseeded.ok) return;
    expect(reseeded.value.serialization).not.toBe(base.serialization);
    expect(reseeded.value.serialization).toContain("seed=43");
  });

  it("the serialization matches an independently rebuilt oracle", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const result = await replay(fixture);

    // The oracle: rebuild the expected header lines from the run's own reported
    // fields, by a different route than `serializeRun` takes.
    const lines = result.serialization.split("\n");
    expect(lines[0]).toBe(SIMULATION_RUN_SERIALIZATION_VERSION);
    expect(lines[1]).toBe(
      [
        "run",
        `simulator=${result.pins.simulatorVersion}`,
        `seed=${result.pins.runSeed}`,
        `fillModel=${result.pins.fillModelVersion}`,
        `fillModelParams=${result.pins.fillModelParametersHash}`,
        `latencyModel=${result.pins.latencyModelVersion}`,
        `latencyModelParams=${result.pins.latencyModelParametersHash}`,
      ].join(" "),
    );
    expect(lines[4]).toBe(
      [
        "counts",
        `read=${String(result.load.rowsRead)}`,
        `delivered=${String(result.load.rowsDelivered)}`,
        `excludedIncident=${String(result.load.rowsExcludedByIncident)}`,
        `excludedDuplicate=${String(result.load.rowsExcludedAsDuplicate)}`,
        `receivedAtInversions=${String(result.load.receivedAtInversions)}`,
      ].join(" "),
    );
    expect(lines[5]).toBe(
      [
        "delivery",
        `envelopes=${String(result.delivery.envelopesDelivered)}`,
        `venueTimestampInversions=${String(result.delivery.venueTimestampInversions)}`,
        `withoutVenueTimestamp=${String(result.delivery.envelopesWithoutVenueTimestamp)}`,
      ].join(" "),
    );
    expect(lines[lines.length - 1]).toBe("end");
  });

  it("serializeRun does not depend on the ORDER of the orders, fills and bands it is given", () => {
    // ROUND-1 REVIEW (L3): this probe used to hand BOTH calls an empty
    // `orders`/`fills` array, so it compared two identical trivial runs and
    // could not have failed against a serializer that emitted insertion order.
    // It now serializes three orders, three fills and two bands, once in one
    // order and once REVERSED, and requires the same bytes.
    const shared = {
      pins: runPins(),
      load: {
        datasetId: "d",
        gatewayEpoch: "e",
        objectsVerified: 1,
        rowsRead: 3,
        rowsDelivered: 3,
        rowsExcludedByIncident: 0,
        rowsExcludedAsDuplicate: 0,
        receivedAtInversions: 0,
        walSegmentVerification: "NOT_AVAILABLE_ARCHIVED_ONLY",
      } as const,
      delivery: {
        envelopesDelivered: 3,
        venueTimestampInversions: 1,
        envelopesWithoutVenueTimestamp: 0,
      },
      clock: {
        advances: 3,
        wallClockRegressions: 0,
        startedAt: "2026-01-01T00:00:00.000Z",
        currentAt: "2026-01-01T00:00:02.000Z",
        startedMonotonicNs: "1000",
        currentMonotonicNs: "3000",
      },
      economics: {
        basis: "REALIZED_IN_REPLAY_PATH",
        buyNotional: "0",
        sellNotional: "0",
        fees: "0",
        netCashFlow: "0",
        sharesBought: "0",
        sharesSold: "0",
        fillCount: 0,
        markoutPenaltyApplied: false,
      } as const,
    };
    const orders = ["order-c", "order-a", "order-b"].map((id) => simulatedOrder(id));
    const fills = ["fill-b", "fill-c", "fill-a"].map((id) => fillNamed(id));
    const bands = [restingBand("order-b", "0.4"), restingBand("order-a", "0.6")];

    const forward = serializeRun({ ...shared, orders, fills, bands });
    const backward = serializeRun({
      ...shared,
      orders: [...orders].reverse(),
      fills: [...fills].reverse(),
      bands: [...bands].reverse(),
    });
    expect(forward).toBe(backward);

    // …and the probe is not vacuous: the run it serialized is non-empty, and the
    // two inputs really were in different orders.
    expect(forward.split("\n").filter((line) => line.startsWith("order "))).toHaveLength(3);
    expect(forward.split("\n").filter((line) => line.startsWith("fill "))).toHaveLength(3);
    expect(forward.split("\n").filter((line) => line.startsWith("band "))).toHaveLength(2);
    expect(orders.map((order) => order.simulatedOrderId)).not.toEqual(
      [...orders].reverse().map((order) => order.simulatedOrderId),
    );
  });
});

const AT_EVENT = {
  gatewayEpoch: "0190a3e0-0000-7000-8000-000000000001",
  ingestSeq: "1",
  receivedAt: "2026-01-01T00:00:00.000Z",
  datasetRowOrdinal: 0,
};

const TIER1 = tier1Model({
  fillModelVersion: "sim/tier1/v1",
  fillModelParametersHash: "0".repeat(64),
});

function simulatedOrder(simulatedOrderId: string): SimulatedOrder {
  return {
    simulatedOrderId,
    plannedOrderId: simulatedOrderId,
    executionPlanId: "plan-1",
    marketId: "0190a3e0-0000-7000-8000-00000000000a",
    tokenId: "1234",
    side: "YES",
    action: "BUY",
    limitPrice: "0.5",
    requestedShares: "10",
    filledShares: "10",
    state: "FILLED",
    postOnly: false,
    executionStyle: "MARKETABLE_LIMIT",
    fillEstimateKind: "POINT",
    atEvent: AT_EVENT,
  };
}

function fillNamed(simulatedFillId: string) {
  return simulatedFill({
    simulatedFillId,
    simulatedOrderId: "order-a",
    marketId: "0190a3e0-0000-7000-8000-00000000000a",
    tokenId: "1234",
    side: "YES",
    action: "BUY",
    price: "0.5",
    shares: "10",
    feeAmount: "0.175",
    liquidityRole: "TAKER",
    model: TIER1,
    atEvent: AT_EVENT,
  });
}

/** A real band, produced by the real model, so the probe serializes real shapes. */
function restingBand(simulatedOrderId: string, restingPrice: string): RestingFillBand {
  const band = simulateResting({
    model: TIER1,
    order: {
      simulatedOrderId,
      marketId: "0190a3e0-0000-7000-8000-00000000000a",
      tokenId: "1234",
      side: "YES",
      action: "BUY",
      restingPrice,
      shares: "50",
      queueAheadAtPlacement: "10",
      sameInstantAdditionsShares: "0",
      restingFromNs: 0n,
    },
    trades: [{ price: restingPrice, shares: "30", monotonicNs: 1_000n, atEvent: AT_EVENT }],
    parameters: {
      queueModelVersion: "sim/queue/v1",
      cancellationRatio: { OPTIMISTIC: "0.5", BASE: "0.1", CONSERVATIVE: "0" },
      cancelEffectiveAfterMs: { OPTIMISTIC: 10, BASE: 50, CONSERVATIVE: 250 },
      placedBehindSameInstantAdditions: { OPTIMISTIC: false, BASE: false, CONSERVATIVE: true },
      basis: "ASSUMED_NOT_MEASURED_NO_PROBE_DATA_EXISTS",
    },
    feeSnapshot: {
      snapshotVersion: "fees/2026-08-24",
      takerFeeRate: "0.07",
      makerFeeRate: "0",
      roundingDecimalPlaces: 5,
      roundingMode: "HALF_UP",
      minimumChargedFee: "0.00001",
      feeCurrency: "USDC",
    },
  });
  if (!band.ok) throw new Error(`${band.refusal.code}: ${band.refusal.message}`);
  return band.value;
}
