/**
 * `SER-2` review, H1: a corrupt segment is EXCLUDED — it is never the reason a
 * whole compaction batch dies.
 *
 * THE DEFECT. `wal-format.ts` recorded an unknown `record` discriminator as
 * `details: { record: <the parsed value> }` — arbitrary `JSON.parse` output
 * from a corrupt line, of unbounded depth and unbounded size.
 * `dataset-manifest.ts` copies `issue.details` into the dataset manifest
 * verbatim, and `SER-2` changed that document's encoder to `encodePlainJson`,
 * whose default `maxDepth` is 64. At base `JSON.stringify` had no depth bound,
 * so the bad segment was excluded and compaction continued; at the first
 * `SER-2` candidate a segment whose discriminator held 65 nested objects made
 * `encodeDatasetManifest` throw `NotPlainJson`/`DEPTH` at `compactor.ts:610` —
 * BEFORE manifest publication and retention — so the good segment's dataset was
 * never published either.
 *
 * THE BAR these tests hold: **no byte sequence a WAL segment file can contain
 * may make a production encoder in this package refuse.** Raising `maxDepth`
 * does not meet it (`JSON.parse` accepts thousands of levels, the encoder's
 * ceiling is `MAX_PLAIN_JSON_DEPTH`, and size is unbounded independently of
 * depth), so the diagnostic is bounded where it is CAPTURED: the scanner
 * renders the discriminator as bounded plain text and
 * `WalSegmentIssueDetail` narrows the whole bag to plain data.
 *
 * FORMAT NOTE. `details.record` therefore reads differently for a corrupt
 * segment than base produced, and a manifest that excludes such a segment has
 * different bytes and a different digest. Nothing pins that shape: every
 * golden, committed manifest and Python validator fixture excludes no segment.
 *
 * These tests FAIL against the candidate's `wal-format.ts` (`cb610e7`): the
 * compaction cases die inside `encodeDatasetManifest`, and the scanner cases
 * see the parsed value instead of its description.
 */

import { describe, expect, it } from "vitest";

import { compactWalDirectory } from "../../../packages/storage-parquet/src/compactor.js";
import type { CompactionResult } from "../../../packages/storage-parquet/src/compactor.js";
import {
  buildSegmentFixture,
  manualClock,
  memoryFileSystem,
  memoryObjectStore,
  recordingRetention,
} from "../../../packages/storage-parquet/src/testing/index.js";
import type { MemoryFileSystem, MemoryObjectStore } from "../../../packages/storage-parquet/src/testing/index.js";
import { readWalSegment, sha256Hex } from "../../../packages/storage-parquet/src/wal-format.js";
import type { WalSegmentIssue } from "../../../packages/storage-parquet/src/wal-format.js";

const EPOCH = "0190a3e0-0000-7000-8000-000000000001";
const WAL_DIR = "/wal";

/** The cap `wal-format.ts` states for diagnostic text (§5's identifier bound). */
const DIAGNOSTIC_TEXT_CAP = 256;

type CorruptSegment = {
  readonly segmentId: string;
  readonly segmentFileName: string;
  readonly manifestFileName: string;
  readonly segmentBytes: Uint8Array;
  readonly manifestBytes: Uint8Array;
};

/**
 * A segment that is a valid header line followed by `lineJson`, and its sidecar
 * manifest — so the compactor treats it as a candidate and the scanner reaches
 * line 1 with a header already in hand.
 */
function segmentWithLine(segmentIndex: number, lineJson: string): CorruptSegment {
  const fixture = buildSegmentFixture({ gatewayEpoch: EPOCH, segmentIndex, frames: [] });
  const bytes = Buffer.from(fixture.segmentBytes);
  const headerEnd = bytes.indexOf(0x0a) + 1;
  return {
    segmentId: fixture.segmentId,
    segmentFileName: fixture.segmentFileName,
    manifestFileName: fixture.manifestFileName,
    segmentBytes: Buffer.concat([bytes.subarray(0, headerEnd), Buffer.from(`${lineJson}\n`, "utf8")]),
    manifestBytes: fixture.manifestBytes,
  };
}

/** The same, with an unknown `record` discriminator on line 1. */
function corruptSegment(segmentIndex: number, discriminatorJson: string): CorruptSegment {
  return segmentWithLine(segmentIndex, `{"record":${discriminatorJson}}`);
}

/** `{"a":{"a":…0…}}`, `levels` deep. `JSON.parse` accepts thousands. */
function nestedObjects(levels: number): string {
  let json = "0";
  for (let level = 0; level < levels; level += 1) {
    json = `{"a":${json}}`;
  }
  return json;
}

/** A wide, shallow object: size without depth. */
function flatBlob(keys: number): string {
  const members: string[] = [];
  for (let index = 0; index < keys; index += 1) {
    members.push(`"k${String(index)}":"${"v".repeat(40)}"`);
  }
  return `{${members.join(",")}}`;
}

type CompactionRun = {
  readonly result: CompactionResult;
  readonly store: MemoryObjectStore;
  readonly fileSystem: MemoryFileSystem;
  readonly validSegmentId: string;
};

/** One real compaction over a valid segment plus `corrupt`, with deleting retention. */
async function compactWith(corrupt: CorruptSegment): Promise<CompactionRun> {
  const fileSystem = memoryFileSystem();
  const store = memoryObjectStore();
  const valid = buildSegmentFixture({
    gatewayEpoch: EPOCH,
    segmentIndex: 0,
    frames: [{ ingestSeq: "1", payloadUtf8: '{"event_type":"book","asset_id":"1"}' }],
  });
  fileSystem.write(WAL_DIR, valid.segmentFileName, valid.segmentBytes);
  fileSystem.write(WAL_DIR, valid.manifestFileName, valid.manifestBytes);
  fileSystem.write(WAL_DIR, corrupt.segmentFileName, corrupt.segmentBytes);
  fileSystem.write(WAL_DIR, corrupt.manifestFileName, corrupt.manifestBytes);

  const result = await compactWalDirectory({
    walDirectoryPath: WAL_DIR,
    datasetId: "ds-1",
    objectKeyPrefix: "datasets/ds-1",
    objectStore: store,
    fileSystem,
    clock: manualClock(),
    retention: recordingRetention({ fileSystem, walDirectoryPath: WAL_DIR, objectStore: store }),
  });
  return { result, store, fileSystem, validSegmentId: valid.segmentId };
}

/** The first issue the reader reports for a segment whose line 1 is `lineJson`. */
async function firstIssueForLine(lineJson: string): Promise<WalSegmentIssue> {
  const corrupt = segmentWithLine(0, lineJson);
  const read = await readWalSegment(
    {
      segmentByteLength: async () => await Promise.resolve(corrupt.segmentBytes.byteLength),
      readSegment: async () => await Promise.resolve(corrupt.segmentBytes),
      readManifest: async () => await Promise.resolve(corrupt.manifestBytes),
    },
    corrupt.segmentId,
  );
  if (read.status !== "refused") {
    throw new Error("expected the reader to refuse the corrupt segment");
  }
  const issue = read.issues[0];
  if (issue === undefined) {
    throw new Error("expected a refusal to carry an issue");
  }
  return issue;
}

/** The first issue for a segment whose line 1 has this `record` discriminator. */
async function firstIssue(discriminatorJson: string): Promise<WalSegmentIssue> {
  return await firstIssueForLine(`{"record":${discriminatorJson}}`);
}

// ---------------------------------------------------------------------------
// The scanner: what a diagnostic says an unknown discriminator WAS
// ---------------------------------------------------------------------------

describe("the scanner renders an unknown record discriminator as bounded plain text", () => {
  const cases: readonly { readonly name: string; readonly json: string; readonly rendered: string }[] = [
    { name: "a string, verbatim", json: '"frame-v2"', rendered: "frame-v2" },
    { name: "an object", json: '{"a":1}', rendered: "an object" },
    { name: "an array", json: "[1,2,3]", rendered: "an array" },
    { name: "a number", json: "7", rendered: "a number" },
    { name: "a boolean", json: "true", rendered: "a boolean" },
    { name: "null", json: "null", rendered: "null" },
    {
      name: "an over-long string, capped with its true length stated",
      json: `"${"x".repeat(300)}"`,
      rendered: `${"x".repeat(DIAGNOSTIC_TEXT_CAP)}... (truncated from 300 characters)`,
    },
  ];

  for (const testCase of cases) {
    it(`renders ${testCase.name}`, async () => {
      const issue = await firstIssue(testCase.json);
      expect(issue.code).toBe("RECORD_INVALID");
      expect(issue.message).toBe("segment line has an unknown record discriminator");
      expect(issue.details?.["record"]).toBe(testCase.rendered);
    });
  }

  it("carries only bounded plain data in every field of the diagnostic", async () => {
    // Depth 1, no parsed containers, and every string within the stated cap
    // plus the marker: the property `dataset-manifest.ts` relies on.
    const issue = await firstIssue(nestedObjects(5_000));
    const details = issue.details ?? {};
    expect(Object.keys(details).sort()).toEqual(["byteOffset", "lineIndex", "record"]);
    for (const value of Object.values(details)) {
      expect(["string", "number", "boolean"]).toContain(typeof value);
      if (typeof value === "string") {
        expect(value.length).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_CAP + 64);
      }
    }
    expect(details["record"]).toBe("an object");
  });
});

describe("the scanner caps every text it takes out of a file", () => {
  it("caps a parse failure's MESSAGE, which interpolates file content", async () => {
    // `parseRawFrameRecord` names the unknown keys it found, and a corrupt
    // line may hold megabytes of them; a message is carried into the manifest
    // next to its `details`, so it is bounded by the same rule.
    const issue = await firstIssueForLine(`{"${"k".repeat(50_000)}":1}`);
    expect(issue.code).toBe("RECORD_INVALID");
    expect(issue.message.startsWith("raw frame record has unknown keys: kkk")).toBe(true);
    expect(issue.message).toContain("(truncated from 50035 characters)");
    expect(issue.message.length).toBeLessThanOrEqual(DIAGNOSTIC_TEXT_CAP + 64);
  });

  it("leaves a well-formed diagnostic untouched: the cap is §5's identifier bound", async () => {
    // A 43-character segment id and a short discriminator are far below the
    // cap, so no legitimate diagnostic reads differently than it did.
    const issue = await firstIssue('"frame-v2"');
    expect(issue.details?.["record"]).toBe("frame-v2");
    expect(issue.message).toBe("segment line has an unknown record discriminator");
  });
});

// ---------------------------------------------------------------------------
// Compaction: exclusion-and-continue survives arbitrary corrupt input
// ---------------------------------------------------------------------------

describe("a corrupt segment is excluded and the batch completes", () => {
  const cases: readonly { readonly name: string; readonly json: string; readonly rendered: string }[] = [
    { name: "65 nested objects (one past the encoder's default depth)", json: nestedObjects(65), rendered: "an object" },
    { name: "5,000 nested objects (far past MAX_PLAIN_JSON_DEPTH)", json: nestedObjects(5_000), rendered: "an object" },
    { name: "a large flat blob (size without depth)", json: flatBlob(20_000), rendered: "an object" },
    {
      name: "a 300,000-character string discriminator",
      json: `"${"z".repeat(300_000)}"`,
      rendered: `${"z".repeat(DIAGNOSTIC_TEXT_CAP)}... (truncated from 300000 characters)`,
    },
  ];

  for (const testCase of cases) {
    it(`completes with ${testCase.name} in the batch`, async () => {
      const corrupt = corruptSegment(1, testCase.json);
      const { result, store, fileSystem, validSegmentId } = await compactWith(corrupt);

      // The good segment was compacted; the bad one was excluded, not fatal.
      expect(result.verifiedSegmentIds).toEqual([validSegmentId]);
      expect(result.rowsWritten).toBe(1);
      expect(result.refusedSegments.map((entry) => entry.segmentId)).toEqual([corrupt.segmentId]);
      const issue = result.refusedSegments[0]?.issues[0];
      expect(issue?.code).toBe("RECORD_INVALID");
      expect(issue?.details?.["record"]).toBe(testCase.rendered);

      // The manifest, its digest sidecar, the receipt and the Parquet object
      // are all in the store — the artifacts the candidate never produced.
      const manifestText = Buffer.from(await store.get(result.manifestObjectKey)).toString("utf8");
      expect(sha256Hex(manifestText)).toBe(result.manifestSha256);
      expect(result.retentionReceiptObjectKey).not.toBeNull();
      expect(result.retentionReceiptSha256).not.toBeNull();
      expect(store.keys().filter((key) => key.endsWith(".parquet"))).toHaveLength(1);
      expect(store.keys().some((key) => key.endsWith("manifest.sha256"))).toBe(true);

      // Retention deleted the verified segment only; the corrupt one is left
      // exactly as found, for the data-quality incident ADR-004 §3 requires.
      expect(result.deletedSegmentIds).toEqual([validSegmentId]);
      expect(await fileSystem.listFileNames(WAL_DIR)).toEqual(
        [corrupt.segmentFileName, corrupt.manifestFileName].sort(),
      );

      // The manifest is decodable, and its size is a function of the dataset
      // rather than of the corrupt line (which is ~1 MB in two of these cases).
      const decoded: unknown = JSON.parse(manifestText);
      const record = (decoded as {
        excludedSegments: readonly { issues: readonly { details: { record: string } }[] }[];
      }).excludedSegments[0]?.issues[0]?.details.record;
      expect(record).toBe(testCase.rendered);
      expect(manifestText.length).toBeLessThan(16 * 1024);
      expect(manifestText).not.toContain('{"a":{"a":');
      expect(manifestText).not.toContain("z".repeat(DIAGNOSTIC_TEXT_CAP + 1));
    });
  }
});
