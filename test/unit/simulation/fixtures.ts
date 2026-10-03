/**
 * Shared fixtures for the `packages/simulation` suites.
 *
 * PROVENANCE. No live venue connection was made, by this package or for these
 * fixtures. Everything here is either repository-assigned by design
 * (`gatewayEpoch`, `ingestSeq`, `receivedAt`, `receivedMonotonicNs`, dataset
 * ids, object keys — §7.1/§7.2 values no venue ever supplies) or a synthetic
 * payload that asserts nothing about the venue. The one venue-shaped fixture,
 * {@link marketChannelFixture}, traces to the frozen WP-000 catalogue under
 * `test/fixtures/venue/market-ws/`, cited at its use site.
 *
 * The dataset manifest built here is in `WP-130`'s
 * `polymarket-bot/dataset-manifest/v1` shape, with its own canonical key order,
 * so the door under test reads a document of exactly the form the compactor
 * writes.
 */

import { createHash } from "node:crypto";

import type {
  ArchivedObject,
  DatasetArchiveReader,
  NormalizeOutcome,
  ReplayNormalizer,
  ReplayRecord,
  ReplayRunPins,
  Sha256HexDigest,
} from "../../../packages/simulation/src/index.js";
import { deriveReplayEventId } from "../../../packages/simulation/src/index.js";

/** The SHA-256 port, supplied by the test the way a composition root supplies it. */
export const sha256Hex: Sha256HexDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export const GATEWAY_EPOCH = "0190a3e0-0000-7000-8000-000000000001";
export const OTHER_EPOCH = "0190a3e0-0000-7000-8000-000000000002";
export const DATASET_ID = "2026-01-01T00-00Z";
export const OBJECT_KEY = "datasets/2026-01-01T00-00Z/part-00000.parquet";
export const SEGMENT_ID = "0190a3e0-0000-7000-8000-000000000001-000000";

/** One synthetic frame, before it becomes a dataset row. */
export interface FrameSpec {
  readonly ingestSeq: string;
  readonly receivedAt: string;
  readonly receivedMonotonicNs: string;
  readonly payloadUtf8: string;
  readonly replayEligible?: boolean;
  readonly exclusionReason?: string | null;
  readonly gatewayEpoch?: string;
  readonly segmentId?: string;
}

/** A decoded dataset row in `WP-130`'s `DecodedDatasetRow` shape. */
export function datasetRow(spec: FrameSpec, ordinal: number, recordIndex: number): unknown {
  const payloadSha256 = createHash("sha256")
    .update(Buffer.from(spec.payloadUtf8, "utf8"))
    .digest("hex");
  return {
    datasetRowOrdinal: ordinal,
    segmentId: spec.segmentId ?? SEGMENT_ID,
    segmentIndex: 0,
    segmentRecordIndex: recordIndex,
    record: {
      gatewayEpoch: spec.gatewayEpoch ?? GATEWAY_EPOCH,
      ingestSeq: spec.ingestSeq,
      source: "polymarket",
      endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      connectionId: "conn-1",
      subscriptionGeneration: 1,
      receivedAt: spec.receivedAt,
      receivedMonotonicNs: spec.receivedMonotonicNs,
      payloadUtf8: spec.payloadUtf8,
      payloadSha256,
    },
    frameLineByteOffset: recordIndex * 256,
    frameLineByteLength: 256,
    frameLineSha256: createHash("sha256")
      .update(Buffer.from(`line:${String(ordinal)}`, "utf8"))
      .digest("hex"),
    replayEligible: spec.replayEligible ?? true,
    exclusionReason: spec.exclusionReason ?? null,
  };
}

/** An excluded window as the manifest records it. */
export interface WindowSpec {
  readonly incidentId: string;
  readonly fromIngestSeq: string;
  readonly toIngestSeq: string;
  readonly excludedRecordCount: number;
  readonly gatewayEpoch?: string;
}

export interface DatasetSpec {
  readonly frames: readonly FrameSpec[];
  readonly windows?: readonly WindowSpec[];
  readonly gatewayEpochs?: readonly string[];
  readonly datasetId?: string;
}

/** Everything a dataset fixture produces. */
export interface DatasetFixture {
  readonly manifestText: string;
  readonly manifestBytes: Uint8Array;
  readonly objectBytes: Uint8Array;
  readonly rows: readonly unknown[];
  readonly archive: DatasetArchiveReader;
}

/**
 * Builds a self-consistent dataset: rows, the object bytes they were decoded
 * from, and a manifest whose pins match both.
 */
export function buildDataset(spec: DatasetSpec): DatasetFixture {
  const rows = spec.frames.map((frame, index) => datasetRow(frame, index, index));
  const objectBytes = new Uint8Array(Buffer.from(JSON.stringify(rows), "utf8"));
  const objectSha256 = sha256Hex(objectBytes);

  const eligible = spec.frames
    .map((frame, index) => ({ frame, index }))
    .filter((entry) => entry.frame.replayEligible !== false);
  const excludedByIncident = spec.frames.filter(
    (frame) => frame.replayEligible === false && (frame.exclusionReason ?? "").startsWith("incident:"),
  ).length;
  const excludedAsDuplicate = spec.frames.filter(
    (frame) => frame.replayEligible === false && (frame.exclusionReason ?? "").startsWith("duplicate:"),
  ).length;

  const first = eligible[0];
  const last = eligible[eligible.length - 1];

  const manifest = {
    datasetManifestFormatId: "polymarket-bot/dataset-manifest/v1",
    datasetManifestVersion: 1,
    datasetId: spec.datasetId ?? DATASET_ID,
    createdAt: "2026-01-01T01:00:00.000Z",
    schemaVersions: {
      walFormatId: "polymarket-bot/wal/v1",
      walSchemaVersion: 1,
      walManifestVersion: 1,
      parquetLayoutId: "polymarket-bot/parquet-raw-frames/v1",
      parquetLayoutVersion: 1,
      datasetManifestFormatId: "polymarket-bot/dataset-manifest/v1",
      datasetManifestVersion: 1,
    },
    writer: {
      library: "hyparquet-writer",
      libraryVersion: "0.16.6",
      codec: "UNCOMPRESSED",
      rowGroupSize: 10000,
    },
    columns: [{ name: "datasetRowOrdinal", physicalType: "INT64", nullable: false }],
    replayPins: {
      normalizerVersion: null,
      featureSetVersion: null,
      runSeed: null,
      fillModelVersion: null,
      latencyModelVersion: null,
      feeSnapshotVersion: null,
      rewardSnapshotVersion: null,
      settlementSpecVersions: [],
      note: "Null entries are run-scoped handoff §12.5 pins a compactor cannot know.",
    },
    gatewayEpochs: spec.gatewayEpochs ?? [GATEWAY_EPOCH],
    eventRange: {
      first:
        first === undefined
          ? null
          : {
              gatewayEpoch: first.frame.gatewayEpoch ?? GATEWAY_EPOCH,
              ingestSeq: first.frame.ingestSeq,
              receivedAt: first.frame.receivedAt,
              datasetRowOrdinal: first.index,
            },
      last:
        last === undefined
          ? null
          : {
              gatewayEpoch: last.frame.gatewayEpoch ?? GATEWAY_EPOCH,
              ingestSeq: last.frame.ingestSeq,
              receivedAt: last.frame.receivedAt,
              datasetRowOrdinal: last.index,
            },
    },
    recordCounts: {
      segmentDeclared: spec.frames.length,
      segmentRead: spec.frames.length,
      written: spec.frames.length,
      replayEligible: eligible.length,
      excludedByIncident,
      excludedAsDuplicate,
    },
    deduplication: {
      policy: "first-wins-in-dispatch-order",
      duplicateRecordCount: excludedAsDuplicate,
      duplicateKeys: [],
      duplicateKeysTruncated: false,
    },
    segments: [
      {
        segmentId: SEGMENT_ID,
        gatewayEpoch: GATEWAY_EPOCH,
        segmentIndex: 0,
        segmentSha256: sha256Hex(new Uint8Array(Buffer.from("segment-span", "utf8"))),
        checksummedByteLength: 1069,
        byteSize: 1100,
        segmentFileSha256: sha256Hex(new Uint8Array(Buffer.from("segment-file", "utf8"))),
        recordCount: spec.frames.length,
        firstIngestSeq: spec.frames[0]?.ingestSeq ?? null,
        lastIngestSeq: spec.frames[spec.frames.length - 1]?.ingestSeq ?? null,
        firstReceivedAt: spec.frames[0]?.receivedAt ?? null,
        lastReceivedAt: spec.frames[spec.frames.length - 1]?.receivedAt ?? null,
        closeReason: "shutdown",
        footerPresent: true,
        truncatedTailBytes: 0,
        objectKey: OBJECT_KEY,
        firstDatasetRowOrdinal: spec.frames.length === 0 ? null : 0,
        lastDatasetRowOrdinal: spec.frames.length === 0 ? null : spec.frames.length - 1,
      },
    ],
    objects: [
      {
        objectKey: OBJECT_KEY,
        byteLength: objectBytes.length,
        sha256: objectSha256,
        rowCount: spec.frames.length,
        replayEligibleRowCount: eligible.length,
        firstDatasetRowOrdinal: spec.frames.length === 0 ? null : 0,
        lastDatasetRowOrdinal: spec.frames.length === 0 ? null : spec.frames.length - 1,
        segmentIds: [SEGMENT_ID],
      },
    ],
    excludedSegments: [],
    excludedIncidentWindows: (spec.windows ?? []).map((window) => ({
      window: {
        incidentId: window.incidentId,
        kind: "gap",
        gatewayEpoch: window.gatewayEpoch ?? GATEWAY_EPOCH,
        fromIngestSeq: window.fromIngestSeq,
        toIngestSeq: window.toIngestSeq,
        openedAt: "2026-01-01T00:00:00.000Z",
        closedAt: "2026-01-01T00:00:10.000Z",
        reason: "a recorded gap",
      },
      excludedRecordCount: window.excludedRecordCount,
      excludedSegmentIds: [SEGMENT_ID],
    })),
    walRetentionPolicy: "retain-all",
  };

  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestBytes = new Uint8Array(Buffer.from(manifestText, "utf8"));

  const archive: DatasetArchiveReader = {
    async readObject(objectKey: string): Promise<ArchivedObject> {
      if (objectKey !== OBJECT_KEY) throw new Error(`no such object ${objectKey}`);
      return await Promise.resolve({ objectKey, bytes: objectBytes, rows });
    },
  };

  return { manifestText, manifestBytes, objectBytes, rows, archive };
}

/**
 * A test normalizer that surfaces the payload's own `t` field as the envelope's
 * `venueTimestamp`.
 *
 * That is what makes `dispatch-order.test.ts` able to compare dispatch order
 * against VENUE-timestamp order rather than against arrival order.
 */
export function venueTimestampNormalizer(normalizerVersion = "test/venue-ts/v1"): ReplayNormalizer {
  return {
    normalizerVersion,
    normalize(record: ReplayRecord): NormalizeOutcome {
      let venueTimestamp: string | undefined;
      try {
        const parsed = JSON.parse(record.frame.payloadUtf8) as { t?: unknown };
        if (typeof parsed.t === "string") venueTimestamp = parsed.t;
      } catch {
        venueTimestamp = undefined;
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
            eventType: "TestEvent",
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

/** A complete §12.5 run pin set. */
export function runPins(overrides: Partial<ReplayRunPins> = {}): ReplayRunPins {
  return {
    normalizerVersion: "test/venue-ts/v1",
    featureSetVersion: "features-v1",
    runSeed: "42",
    fillModelVersion: "sim/tier0/v1",
    fillModelParametersHash: "0".repeat(64),
    latencyModelVersion: "sim/latency/v1",
    latencyModelParametersHash: "1".repeat(64),
    feeSnapshotVersion: "fees/2026-08-24",
    rewardSnapshotVersion: "rewards/2026-08-24",
    settlementSpecVersions: [],
    simulatorVersion: "wp-210/v2",
    // `CADENCE-1` (ADR-026 D1.3): the evaluation cadence every run pins.
    evaluationIntervalMs: 1000,
    evaluationHeartbeatMs: 5000,
    ...overrides,
  };
}

/** Frames whose VENUE timestamps disagree with their dispatch order. */
export const OUT_OF_ORDER_VENUE_FRAMES: readonly FrameSpec[] = Object.freeze([
  {
    ingestSeq: "1",
    receivedAt: "2026-01-01T00:00:00.100Z",
    receivedMonotonicNs: "1000000000",
    payloadUtf8: '{"t":"2026-01-01T00:00:00.300Z","n":1}',
  },
  {
    ingestSeq: "2",
    receivedAt: "2026-01-01T00:00:00.200Z",
    receivedMonotonicNs: "1100000000",
    payloadUtf8: '{"t":"2026-01-01T00:00:00.100Z","n":2}',
  },
  {
    ingestSeq: "3",
    receivedAt: "2026-01-01T00:00:00.300Z",
    receivedMonotonicNs: "1200000000",
    payloadUtf8: '{"t":"2026-01-01T00:00:00.200Z","n":3}',
  },
]);
