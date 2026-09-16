/**
 * `apps/backtest-cli` — the composition root, end to end.
 *
 * The end-to-end probe writes a REAL Parquet object with `WP-130`'s own writer,
 * a real dataset manifest beside it, and then runs `runBacktest` over the
 * directory. Nothing is stubbed between the manifest bytes and the delivered
 * events, so the checksum verification, the strict-JSON manifest door, the
 * Parquet decode, the dispatch ordering and the canonical serialization are all
 * exercised against the artifacts the recorder pipeline actually produces.
 *
 * SAFETY: no venue connection, no credential, and no order. The safety suite
 * below pins that a BACKTEST process REFUSES to start under a raised run-mode
 * ceiling, a non-false `ALLOW_REAL_ORDERS`, a non-zero live-micro cap, or an
 * environment carrying anything that looks like a key (§6 invariant 17, §11).
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeParquetObject, type DatasetRow } from "@polymarket-bot/storage-parquet";
import { describe, expect, it } from "vitest";

import { readManifestBytes, resolveWithinRoot, sha256Hex } from "./archive.js";
import { EXIT_REFUSED, EXIT_USAGE, main, normalizerFor, parseArguments } from "./main.js";
import {
  RECORDED_FRAME_NORMALIZER_VERSION,
  recordedFrameNormalizer,
} from "./normalizer.js";
import { checkBacktestSafety } from "./safety.js";
import { DATASET_MANIFEST_OBJECT_NAME, renderBacktestOutcome, runBacktest } from "./run.js";

const GATEWAY_EPOCH = "0190a3e0-0000-7000-8000-000000000001";
const SEGMENT_ID = "0190a3e0-0000-7000-8000-000000000001-000000";
const OBJECT_KEY = "part-00000.parquet";

const FRAMES: readonly { ingestSeq: string; receivedAt: string; monotonicNs: string; payload: string }[] = [
  {
    ingestSeq: "1",
    receivedAt: "2026-06-29T17:15:57.300Z",
    monotonicNs: "1000000000",
    payload: '{"event_type":"book","asset_id":"7134526469571836016"}',
  },
  {
    ingestSeq: "4",
    receivedAt: "2026-06-29T17:15:57.400Z",
    monotonicNs: "1100000000",
    payload: '{"event_type":"price_change","asset_id":"7134526469571836016"}',
  },
];

function datasetRows(): readonly DatasetRow[] {
  return FRAMES.map((frame, index) => ({
    datasetRowOrdinal: index,
    segmentId: SEGMENT_ID,
    segmentIndex: 0,
    segmentRecordIndex: index,
    record: {
      gatewayEpoch: GATEWAY_EPOCH,
      ingestSeq: frame.ingestSeq,
      source: "polymarket",
      endpoint: "wss://ws-subscriptions-clob.polymarket.com/ws/market",
      connectionId: "conn-1",
      subscriptionGeneration: 1,
      receivedAt: frame.receivedAt,
      receivedMonotonicNs: frame.monotonicNs,
      payloadUtf8: frame.payload,
      payloadSha256: sha256Hex(new Uint8Array(Buffer.from(frame.payload, "utf8"))),
    },
    frameLineByteOffset: index * 256,
    frameLineByteLength: 256,
    frameLineSha256: sha256Hex(new Uint8Array(Buffer.from(`line:${String(index)}`, "utf8"))),
    replayEligible: true,
    exclusionReason: null,
  }));
}

/** Writes a dataset directory: one real Parquet object plus its manifest. */
function writeDataset(): string {
  const directory = mkdtempSync(join(tmpdir(), "wp210-backtest-"));
  const rows = datasetRows();
  const object = writeParquetObject({ rows });
  writeFileSync(join(directory, OBJECT_KEY), object.bytes);

  const manifest = {
    datasetManifestFormatId: "polymarket-bot/dataset-manifest/v1",
    datasetManifestVersion: 1,
    datasetId: "2026-06-29T17-00Z",
    createdAt: "2026-06-29T18:00:00.000Z",
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
      note: "run-scoped pins a compactor cannot know",
    },
    gatewayEpochs: [GATEWAY_EPOCH],
    eventRange: {
      first: {
        gatewayEpoch: GATEWAY_EPOCH,
        ingestSeq: "1",
        receivedAt: FRAMES[0]?.receivedAt ?? "",
        datasetRowOrdinal: 0,
      },
      last: {
        gatewayEpoch: GATEWAY_EPOCH,
        ingestSeq: "4",
        receivedAt: FRAMES[1]?.receivedAt ?? "",
        datasetRowOrdinal: 1,
      },
    },
    recordCounts: {
      segmentDeclared: 2,
      segmentRead: 2,
      written: 2,
      replayEligible: 2,
      excludedByIncident: 0,
      excludedAsDuplicate: 0,
    },
    deduplication: {
      policy: "first-wins-in-dispatch-order",
      duplicateRecordCount: 0,
      duplicateKeys: [],
      duplicateKeysTruncated: false,
    },
    segments: [
      {
        segmentId: SEGMENT_ID,
        gatewayEpoch: GATEWAY_EPOCH,
        segmentIndex: 0,
        segmentSha256: sha256Hex(new Uint8Array(Buffer.from("span", "utf8"))),
        checksummedByteLength: 512,
        byteSize: 600,
        segmentFileSha256: sha256Hex(new Uint8Array(Buffer.from("file", "utf8"))),
        recordCount: 2,
        firstIngestSeq: "1",
        lastIngestSeq: "4",
        firstReceivedAt: FRAMES[0]?.receivedAt ?? null,
        lastReceivedAt: FRAMES[1]?.receivedAt ?? null,
        closeReason: "shutdown",
        footerPresent: true,
        truncatedTailBytes: 0,
        objectKey: OBJECT_KEY,
        firstDatasetRowOrdinal: 0,
        lastDatasetRowOrdinal: 1,
      },
    ],
    objects: [
      {
        objectKey: OBJECT_KEY,
        byteLength: object.bytes.length,
        sha256: object.sha256,
        rowCount: 2,
        replayEligibleRowCount: 2,
        firstDatasetRowOrdinal: 0,
        lastDatasetRowOrdinal: 1,
        segmentIds: [SEGMENT_ID],
      },
    ],
    excludedSegments: [],
    excludedIncidentWindows: [],
    walRetentionPolicy: "retain-all",
  };
  writeFileSync(
    join(directory, DATASET_MANIFEST_OBJECT_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

function pins() {
  return {
    normalizerVersion: RECORDED_FRAME_NORMALIZER_VERSION,
    featureSetVersion: "features-v1",
    runSeed: "42",
    fillModelVersion: "sim/tier0/v1",
    fillModelParametersHash: "0".repeat(64),
    latencyModelVersion: "sim/latency/v1",
    latencyModelParametersHash: "1".repeat(64),
    feeSnapshotVersion: "fees/2026-08-24",
    rewardSnapshotVersion: "rewards/2026-08-24",
    settlementSpecVersions: [] as readonly string[],
    simulatorVersion: "wp-210/v1",
  };
}

describe("startup safety validation (§6 invariant 17, §11, AGENTS.md)", () => {
  it("accepts a clean environment", () => {
    expect(checkBacktestSafety({ PATH: "/usr/bin", NODE_ENV: "test" }).ok).toBe(true);
  });

  it("refuses anything that looks like a key, and never echoes its value", () => {
    const outcome = checkBacktestSafety({ POLYMARKET_PRIVATE_KEY: "0xdeadbeef" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.violations[0]?.code).toBe("BACKTEST_CREDENTIAL_PRESENT");
    expect(JSON.stringify(outcome.violations)).not.toContain("0xdeadbeef");
  });

  it.each([
    ["PROD_SIGNER_KEY", "x"],
    ["CLOB_API_SECRET", "x"],
    ["WALLET_MNEMONIC", "x"],
    ["A_SEED_PHRASE", "x"],
    ["CLOB_PASSPHRASE", "x"],
    ["KEYSTORE_PATH", "x"],
  ])("refuses %s", (name, value) => {
    expect(checkBacktestSafety({ [name]: value }).ok).toBe(false);
  });

  it("refuses a raised run-mode ceiling", () => {
    expect(checkBacktestSafety({ MAX_RUN_MODE: "LIVE" }).ok).toBe(false);
    expect(checkBacktestSafety({ MAX_RUN_MODE: "LIVE_MICRO" }).ok).toBe(false);
    expect(checkBacktestSafety({ MAX_RUN_MODE: "PAPER" }).ok).toBe(true);
  });

  it("refuses ALLOW_REAL_ORDERS that is not false", () => {
    expect(checkBacktestSafety({ ALLOW_REAL_ORDERS: "true" }).ok).toBe(false);
    expect(checkBacktestSafety({ ALLOW_REAL_ORDERS: "false" }).ok).toBe(true);
  });

  it("refuses a non-zero live-micro cap", () => {
    expect(checkBacktestSafety({ LIVE_MICRO_MAX_ORDER_NOTIONAL: "1" }).ok).toBe(false);
    expect(checkBacktestSafety({ LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "100" }).ok).toBe(false);
    expect(
      checkBacktestSafety({
        LIVE_MICRO_MAX_ORDER_NOTIONAL: "0",
        LIVE_MICRO_MAX_ACCOUNT_EXPOSURE: "0",
      }).ok,
    ).toBe(true);
  });

  it("stops the run before it reads anything", async () => {
    const outcome = await runBacktest({
      datasetDirectory: "/nonexistent",
      normalizer: recordedFrameNormalizer(sha256Hex),
      runPins: pins(),
      environment: { POLYMARKET_PRIVATE_KEY: "x" },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect("safety" in outcome).toBe(true);
    expect(renderBacktestOutcome(outcome)).toContain("startup safety validation failed");
  });
});

describe("the archive adapter", () => {
  it("refuses an object key that resolves outside the dataset root", () => {
    expect(() => resolveWithinRoot("/tmp/dataset", "../../etc/passwd")).toThrow(/outside/u);
    expect(resolveWithinRoot("/tmp/dataset", "part-0.parquet")).toBe("/tmp/dataset/part-0.parquet");
  });
});

describe("the CLI, end to end over a real Parquet dataset", () => {
  it("verifies the dataset and emits the canonical run serialization", async () => {
    const directory = writeDataset();
    const outcome = await runBacktest({
      datasetDirectory: directory,
      normalizer: recordedFrameNormalizer(sha256Hex),
      runPins: pins(),
      environment: {},
    });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.runMode).toBe("BACKTEST");
    expect(outcome.result.eventsDelivered).toBe(2);
    expect(outcome.result.load.objectsVerified).toBe(1);
    expect(outcome.result.load.rowsDelivered).toBe(2);
    expect(outcome.result.serialization).toContain("polymarket-bot/simulation-run/v3");
    expect(outcome.result.serialization).toContain("counts read=2 delivered=2");
    expect(renderBacktestOutcome(outcome)).toContain("run_mode=BACKTEST");
  });

  it("is byte-identical across two runs of the same dataset and pins", async () => {
    const directory = writeDataset();
    const first = await runBacktest({
      datasetDirectory: directory,
      normalizer: recordedFrameNormalizer(sha256Hex),
      runPins: pins(),
      environment: {},
    });
    const second = await runBacktest({
      datasetDirectory: directory,
      normalizer: recordedFrameNormalizer(sha256Hex),
      runPins: pins(),
      environment: {},
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.result.serialization).toBe(first.result.serialization);
  });

  it("refuses a tampered object rather than replaying it", async () => {
    const directory = writeDataset();
    const original = await readManifestBytes(directory, DATASET_MANIFEST_OBJECT_NAME);
    expect(original.length).toBeGreaterThan(0);
    writeFileSync(join(directory, OBJECT_KEY), Buffer.from("not a parquet file", "utf8"));
    const outcome = await runBacktest({
      datasetDirectory: directory,
      normalizer: recordedFrameNormalizer(sha256Hex),
      runPins: pins(),
      environment: {},
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect("refusal" in outcome).toBe(true);
    if (!("refusal" in outcome)) return;
    expect(["REPLAY_OBJECT_CHECKSUM_MISMATCH", "REPLAY_ARCHIVE_UNREADABLE"]).toContain(
      outcome.refusal.code,
    );
  });

  it("refuses a normalizer version the dataset does not pin to", async () => {
    const directory = writeDataset();
    const outcome = await runBacktest({
      datasetDirectory: directory,
      normalizer: {
        normalizerVersion: "some-other-normalizer/v9",
        normalize: () => ({ ok: false, reason: "never reached" }),
      },
      runPins: pins(),
      environment: {},
    });
    // The dataset's own pin is null, so the mismatch surfaces against the RUN
    // pin instead: the run says which normalizer it used, and it must be the one.
    expect(outcome.ok).toBe(false);
  });
});

describe("the CLI argument surface", () => {
  it("parses a command and its options", () => {
    const parsed = parseArguments(["verify", "--dataset", "/tmp/d", "--pins", "/tmp/p.json"]);
    expect("usage" in parsed).toBe(false);
    if ("usage" in parsed) return;
    expect(parsed.command).toBe("verify");
    expect(parsed.options["dataset"]).toBe("/tmp/d");
  });

  it("reports usage rather than guessing", () => {
    expect("usage" in parseArguments([])).toBe(true);
    expect("usage" in parseArguments(["--dataset"])).toBe(true);
    expect("usage" in parseArguments(["verify", "--dataset"])).toBe(true);
  });

  it("exits with the usage code for an unknown command", async () => {
    const errors: string[] = [];
    const code = await main({
      argv: ["frobnicate"],
      environment: {},
      out: () => undefined,
      err: (line) => errors.push(line),
    });
    expect(code).toBe(EXIT_USAGE);
    expect(errors.join("\n")).toContain("unknown command");
  });

  it("runs verify end to end and prints the serialization", async () => {
    const directory = writeDataset();
    const pinsPath = join(directory, "run-pins.json");
    writeFileSync(pinsPath, `${JSON.stringify(pins(), null, 2)}\n`, "utf8");
    const output: string[] = [];
    const code = await main({
      argv: ["verify", "--dataset", directory, "--pins", pinsPath],
      environment: {},
      out: (line) => output.push(line),
      err: (line) => output.push(line),
    });
    expect(output.join("\n")).toContain("polymarket-bot/simulation-run/v3");
    expect(code).toBe(0);
  });

  it("refuses a run-pins file that is not strict JSON", async () => {
    const directory = writeDataset();
    const pinsPath = join(directory, "bad-pins.json");
    writeFileSync(pinsPath, '{"runSeed": "1", "runSeed": "2"}', "utf8");
    const errors: string[] = [];
    const code = await main({
      argv: ["verify", "--dataset", directory, "--pins", pinsPath],
      environment: {},
      out: () => undefined,
      err: (line) => errors.push(line),
    });
    expect(code).toBe(EXIT_REFUSED);
    expect(errors.join("\n")).toContain("duplicate object key");
  });

  it("selects the shipped normalizer the pins name: verify over the committed BACKTEST-1 fixture (no core)", async () => {
    // The executable drives NO core (`run.ts` header): over the
    // normalized-stream recording it verifies, replays and reports a
    // venue-free run — eight envelopes delivered, zero fills — which is the
    // measured shape of every replay at base 1aa2238. The core-driven run over
    // the SAME fixture is `test/unit/simulation/backtest-static-bracket-replay.test.ts`.
    const fixture = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../test/replay-golden/backtest/static-bracket",
    );
    const output: string[] = [];
    const code = await main({
      argv: ["verify", "--dataset", fixture, "--pins", join(fixture, "run-pins.json")],
      environment: {},
      out: (line) => output.push(line),
      err: (line) => output.push(line),
    });
    const rendered = output.join("\n");
    expect(rendered, rendered).toContain("run_mode=BACKTEST");
    expect(rendered).toContain("events_delivered=8");
    expect(rendered).toContain("pins normalizer=backtest-cli/normalized-envelope/v1");
    expect(rendered).toContain("fills=0");
    expect(rendered).not.toMatch(/^order /mu);
    expect(code).toBe(0);
    // A pin set naming a version this executable does not ship still falls to
    // the passthrough, and the pin door refuses the disagreement by name.
    expect(normalizerFor({ ...pins(), normalizerVersion: "someone-else/v9" }).normalizerVersion).toBe(
      RECORDED_FRAME_NORMALIZER_VERSION,
    );
  });
});
