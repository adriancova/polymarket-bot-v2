/**
 * `SER-2`: every byte `packages/storage-parquet` persists is a function of the
 * document's OWN data — the re-encoded frame line, the dataset manifest, the
 * retention receipt, and the two digests computed from them.
 *
 * THE CLASS. `JSON.stringify` resolves `toJSON` through the value's PROTOTYPE
 * CHAIN (ECMA-262 25.5.2), so a `toJSON` inherited from `Object.prototype` or
 * `Array.prototype` replaces the bytes of ANY object and ANY array, and one on
 * `BigInt.prototype` turns a bigint's `TypeError` into accepted bytes. Six
 * contexts (`SER-0`): three prototypes × {enumerable assignment,
 * non-enumerable `defineProperty`}.
 *
 * THE SITES (`docs/handoffs/SER-0-sweep.md`, area `parquet`, all HIGH):
 * `wal-format.ts` `encodeFrameLine` — `rowReproducesItsSourceLine` flipped
 * false and replay consumers received the wrong bytes; `dataset-manifest.ts`
 * `encodeDatasetManifest` (and `datasetManifestDigest`, which hashes the same
 * bytes) — persisted to the immutable object store with a digest
 * self-consistent with the WRONG bytes, which retention then refused;
 * `retention-receipt.ts` `encodeRetentionReceipt` (and its digest).
 *
 * THE PINS. (1) The FORMAT guard — a clean `JSON.stringify` of the same
 * literal, in the fixed key order and with the two-space gap — passes at base
 * too; it is what keeps every golden, the Python validator's committed
 * fixture and the manifest digests byte-identical. (2) Six-context invariance
 * of the three encoders, the two digests and `rowReproducesItsSourceLine`,
 * with the injected `toJSON` counted at zero. (3) END TO END: a real
 * `compactWalDirectory` with delete-after-verify retention, run INSIDE each
 * context over the in-memory ports, stores the same objects a clean run
 * stores — manifest, digest sidecar, receipt, Parquet — and its retention
 * succeeds against the manifest it read back.
 *
 * THE PROTOCOL: `test/unit/ledger/inherited-tojson.ts` for the synchronous
 * encoders; `test/unit/storage-postgres/support/inherited-tojson-async.ts`
 * for the compaction. Install → call → capture a STRING → restore in a
 * `finally` → assert.
 */

import { describe, expect, it } from "vitest";

import { compactWalDirectory } from "../../../packages/storage-parquet/src/compactor.js";
import type { CompactionResult } from "../../../packages/storage-parquet/src/compactor.js";
import {
  datasetManifestDigest,
  encodeDatasetManifest,
} from "../../../packages/storage-parquet/src/dataset-manifest.js";
import type { DatasetManifest } from "../../../packages/storage-parquet/src/dataset-manifest.js";
import {
  datasetRowFromWalRecord,
  rowReproducesItsSourceLine,
} from "../../../packages/storage-parquet/src/parquet-layout.js";
import {
  buildRetentionReceipt,
  encodeRetentionReceipt,
  retentionReceiptDigest,
} from "../../../packages/storage-parquet/src/retention-receipt.js";
import type { RetentionReceipt } from "../../../packages/storage-parquet/src/retention-receipt.js";
import {
  buildSegmentFixture,
  manualClock,
  memoryFileSystem,
  memoryObjectStore,
  recordingRetention,
} from "../../../packages/storage-parquet/src/testing/index.js";
import { encodeFrameLine, sha256Hex } from "../../../packages/storage-parquet/src/wal-format.js";
import type { RawFrameRecord } from "../../../packages/storage-parquet/src/wal-format.js";
import {
  renderDivergences,
  sweepInheritedToJson,
  TOJSON_CONTEXTS,
} from "../ledger/inherited-tojson.js";
import { withInheritedToJsonAsync } from "../storage-postgres/support/inherited-tojson-async.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";
const WAL_DIR = "/wal";

function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/** The frame's ten keys in the `wal-format.md` §5 order, as a literal a clean `JSON.stringify` renders. */
function frameLiteral(record: RawFrameRecord): Record<string, unknown> {
  return {
    gatewayEpoch: record.gatewayEpoch,
    ingestSeq: record.ingestSeq,
    source: record.source,
    endpoint: record.endpoint,
    connectionId: record.connectionId,
    subscriptionGeneration: record.subscriptionGeneration,
    receivedAt: record.receivedAt,
    receivedMonotonicNs: record.receivedMonotonicNs,
    payloadUtf8: record.payloadUtf8,
    payloadSha256: record.payloadSha256,
  };
}

// ---------------------------------------------------------------------------
// A real compaction over the in-memory ports; `run` is the caller's window
// ---------------------------------------------------------------------------

async function compact(
  run: <T>(work: () => Promise<T>) => Promise<T>,
): Promise<{
  readonly result: CompactionResult;
  readonly objects: Readonly<Record<string, string>>;
  readonly walFiles: readonly string[];
}> {
  const fileSystem = memoryFileSystem();
  const store = memoryObjectStore();
  const clock = manualClock();
  const fixture = buildSegmentFixture({
    gatewayEpoch: EPOCH,
    segmentIndex: 0,
    frames: [
      { ingestSeq: "1", payloadUtf8: '{"event_type":"book","asset_id":"1","bids":[["0.4","10"]]}' },
      { ingestSeq: "2", payloadUtf8: "PING", receivedAt: "2026-01-01T00:00:10.000Z" },
      { ingestSeq: "3", payloadUtf8: '{"event_type":"price_change"}', receivedAt: "2026-01-01T00:00:20.000Z" },
    ],
  });
  fileSystem.write(WAL_DIR, fixture.segmentFileName, fixture.segmentBytes);
  fileSystem.write(WAL_DIR, fixture.manifestFileName, fixture.manifestBytes);
  const retention = recordingRetention({ fileSystem, walDirectoryPath: WAL_DIR, objectStore: store });

  const result = await run(async () =>
    await compactWalDirectory({
      walDirectoryPath: WAL_DIR,
      datasetId: "ds-1",
      objectKeyPrefix: "datasets/ds-1",
      objectStore: store,
      fileSystem,
      clock,
      retention,
    }),
  );

  const objects: Record<string, string> = {};
  for (const key of store.keys()) {
    const bytes = await store.get(key);
    // Text for the JSON artifacts, a digest for the Parquet object.
    objects[key] = key.endsWith(".parquet") ? `sha256:${sha256Hex(bytes)}` : text(bytes);
  }
  return { result, objects, walFiles: [...(await fileSystem.listFileNames(WAL_DIR))].sort() };
}

/** The value-bearing half of a result, as a comparable string. */
function summarize(result: CompactionResult): string {
  return [
    `manifest=${result.manifestSha256}`,
    `receipt=${String(result.retentionReceiptSha256)}`,
    `deleted=${result.deletedSegmentIds.join(",")}`,
    `failures=${result.retentionFailures.map((entry) => `${entry.segmentId}:${entry.detail}`).join(";")}`,
    `rows=${String(result.rowsWritten)}/${String(result.replayEligibleRows)}`,
    `refused=${String(result.refusedSegments.length)}`,
  ].join(" ");
}

// ---------------------------------------------------------------------------

describe("the persisted formats are byte-identical to a clean JSON.stringify (format guard; passes at base)", () => {
  it("frame line, in the wal-format.md §5 key order", () => {
    const fixture = buildSegmentFixture({
      gatewayEpoch: EPOCH,
      segmentIndex: 0,
      frames: [{ ingestSeq: "1", payloadUtf8: '{"a":"tab\\tquote\\"lf\\n"}' }],
    });
    const record = fixture.records[0];
    if (record === undefined) throw new Error("fixture has no record");
    expect(text(encodeFrameLine(record))).toBe(`${JSON.stringify(frameLiteral(record))}\n`);
  });

  it("dataset manifest: two-space gap, trailing LF, and the bytes the store holds", async () => {
    const { result, objects } = await compact(async (work) => await work());
    const encoded = text(encodeDatasetManifest(result.manifest));
    expect(encoded).toBe(`${JSON.stringify(JSON.parse(encoded), null, 2)}\n`);
    expect(objects[result.manifestObjectKey]).toBe(encoded);
    expect(sha256Hex(encoded)).toBe(result.manifestSha256);
    expect(datasetManifestDigest(result.manifest)).toBe(result.manifestSha256);
  });

  it("retention receipt: two-space gap, trailing LF, and the bytes the store holds", async () => {
    const { result, objects } = await compact(async (work) => await work());
    expect(result.retentionReceiptObjectKey).not.toBeNull();
    const stored = objects[result.retentionReceiptObjectKey ?? ""];
    expect(stored).toBeDefined();
    expect(stored).toBe(`${JSON.stringify(JSON.parse(stored ?? ""), null, 2)}\n`);
    expect(sha256Hex(stored ?? "")).toBe(result.retentionReceiptSha256);

    const receipt: RetentionReceipt = buildRetentionReceipt({
      datasetId: "ds-x",
      datasetManifestObjectKey: "datasets/ds-x/manifest.json",
      datasetManifestSha256: "a".repeat(64),
      walRetentionPolicy: "delete-after-verified-upload",
      completedAt: "2026-01-01T00:00:00.000Z",
      deletedSegments: [{ segmentId: "s-0", verifiedObjectKey: "k", verifiedObjectSha256: "b".repeat(64) }],
      retentionFailures: [{ segmentId: "s-1", detail: "read-back mismatch" }],
    });
    expect(text(encodeRetentionReceipt(receipt))).toBe(`${JSON.stringify(receipt, null, 2)}\n`);
  });
});

describe("the encoders, the digests and the row check are invariant under the six contexts", () => {
  it("emit the clean bytes in every context, and the injected toJSON never runs", async () => {
    const { result } = await compact(async (work) => await work());
    const manifest: DatasetManifest = result.manifest;
    const fixture = buildSegmentFixture({
      gatewayEpoch: EPOCH,
      segmentIndex: 0,
      frames: [{ ingestSeq: "1", payloadUtf8: '{"event_type":"book"}' }],
    });
    const record = fixture.records[0];
    if (record === undefined) throw new Error("fixture has no record");
    const cleanLine = encodeFrameLine(record);
    const row = datasetRowFromWalRecord({
      datasetRowOrdinal: 0,
      segmentId: fixture.segmentId,
      segmentIndex: 0,
      entry: {
        recordIndex: 0,
        byteOffset: 0,
        byteLength: cleanLine.byteLength,
        lineSha256: sha256Hex(cleanLine),
        record,
      },
      replayEligible: true,
      exclusionReason: null,
    });
    const receipt = buildRetentionReceipt({
      datasetId: "ds-x",
      datasetManifestObjectKey: "datasets/ds-x/manifest.json",
      datasetManifestSha256: "a".repeat(64),
      walRetentionPolicy: "delete-after-verified-upload",
      completedAt: "2026-01-01T00:00:00.000Z",
      deletedSegments: [{ segmentId: "s-0", verifiedObjectKey: "k", verifiedObjectSha256: "b".repeat(64) }],
      retentionFailures: [],
    });

    const sweep = sweepInheritedToJson([
      { name: "encodeFrameLine", render: () => text(encodeFrameLine(record)) },
      { name: "rowReproducesItsSourceLine", render: () => String(rowReproducesItsSourceLine(row)) },
      { name: "encodeDatasetManifest", render: () => text(encodeDatasetManifest(manifest)) },
      { name: "datasetManifestDigest", render: () => datasetManifestDigest(manifest) },
      { name: "encodeRetentionReceipt", render: () => text(encodeRetentionReceipt(receipt)) },
      { name: "retentionReceiptDigest", render: () => retentionReceiptDigest(receipt) },
    ]);
    expect(renderDivergences(sweep.divergences)).toEqual([]);
    expect(sweep.clean.get("rowReproducesItsSourceLine")).toBe("ok:true");
    expect(sweep.clean.get("datasetManifestDigest")).toBe(`ok:${result.manifestSha256}`);
    expect(sweep.clean.get("encodeFrameLine")).toBe(`ok:${JSON.stringify(frameLiteral(record))}\n`);
  });
});

describe("a real compaction with delete-after-verify retention persists the clean objects under every context", () => {
  it("stores the same manifest, digest sidecar, receipt and Parquet object, and retention succeeds", async () => {
    const clean = await compact(async (work) => await work());
    expect(summarize(clean.result)).toMatch(/^manifest=[0-9a-f]{64} receipt=[0-9a-f]{64} deleted=[^ ]+ failures= rows=3\/3 refused=0$/u);
    expect(Object.keys(clean.objects).length).toBe(4);
    expect(clean.walFiles).toEqual([]);
    expect(Object.values(clean.objects).some((value) => value.includes("INJECTED"))).toBe(false);

    for (const context of TOJSON_CONTEXTS) {
      // The window covers `compactWalDirectory` alone: the fixture builder
      // (`testing/wal-fixture.ts`, test-only, deliberately a second
      // implementation) and the read-back stay outside it.
      let calls = -1;
      const polluted = await compact(async (work) => {
        const run = await withInheritedToJsonAsync(context, work);
        calls = run.calls;
        return run.result;
      });
      expect(calls, context.name).toBe(0);
      expect(summarize(polluted.result), context.name).toBe(summarize(clean.result));
      expect(polluted.objects, context.name).toEqual(clean.objects);
      expect(polluted.walFiles, context.name).toEqual([]);
    }
  });
});
