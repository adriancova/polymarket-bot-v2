import { describe, expect, it } from "vitest";

import { WAL_FORMAT_ID, WAL_MANIFEST_VERSION, WAL_SCHEMA_VERSION } from "./constants.js";
import { WalManifestError } from "./errors.js";
import {
  defaultSegmentIdFactory,
  encodeSegmentManifest,
  isSegmentFileName,
  listSegmentManifests,
  manifestFileName,
  parseSegmentManifest,
  readSegmentManifest,
  segmentFileName,
  segmentIdFromFileName,
  writeSegmentManifest,
} from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import { createMemoryFileSystem } from "./testing/memory-file-system.js";

const manifest: WalSegmentManifest = {
  manifestVersion: WAL_MANIFEST_VERSION,
  formatId: WAL_FORMAT_ID,
  walSchemaVersion: WAL_SCHEMA_VERSION,
  segmentId: "epoch-000003",
  gatewayEpoch: "epoch",
  segmentIndex: 3,
  segmentFileName: "epoch-000003.wal.jsonl",
  recordCount: 12,
  firstIngestSeq: "100",
  lastIngestSeq: "111",
  firstReceivedAt: "2026-01-01T00:00:00.000Z",
  lastReceivedAt: "2026-01-01T00:00:10.000Z",
  byteSize: 4096,
  checksummedByteLength: 3800,
  segmentSha256: "c".repeat(64),
  createdAt: "2026-01-01T00:00:00.000Z",
  closedAt: "2026-01-01T00:00:11.000Z",
  closeReason: "size-rotation",
  footerPresent: true,
  truncatedTailBytes: 0,
};

function decode(bytes: Uint8Array): unknown {
  return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
}

describe("manifest encoding", () => {
  it("round-trips", () => {
    expect(parseSegmentManifest(decode(encodeSegmentManifest(manifest)))).toEqual(manifest);
  });

  it("is human-readable and newline-terminated", () => {
    const text = Buffer.from(encodeSegmentManifest(manifest)).toString("utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('\n  "segmentId": "epoch-000003"');
  });

  it("keeps a null record range for an empty segment", () => {
    const empty: WalSegmentManifest = {
      ...manifest,
      recordCount: 0,
      firstIngestSeq: null,
      lastIngestSeq: null,
      firstReceivedAt: null,
      lastReceivedAt: null,
    };
    expect(parseSegmentManifest(decode(encodeSegmentManifest(empty)))).toEqual(empty);
  });

  const rejections: readonly (readonly [string, unknown])[] = [
    ["a non-object", "manifest"],
    ["null", null],
    ["an array", []],
    ["an unknown format", { ...manifest, formatId: "other/wal/v1" }],
    ["an unsupported manifest version", { ...manifest, manifestVersion: 99 }],
    ["an unsupported schema version", { ...manifest, walSchemaVersion: 99 }],
    ["a malformed checksum", { ...manifest, segmentSha256: "nope" }],
    ["an uppercase checksum", { ...manifest, segmentSha256: "C".repeat(64) }],
    ["an unknown close reason", { ...manifest, closeReason: "vibes" }],
    ["a negative record count", { ...manifest, recordCount: -1 }],
    ["a fractional byte size", { ...manifest, byteSize: 1.5 }],
    ["a non-boolean footerPresent", { ...manifest, footerPresent: "yes" }],
    ["an empty segment id", { ...manifest, segmentId: "" }],
    ["an empty-string ingest sequence", { ...manifest, firstIngestSeq: "" }],
  ];

  it.each(rejections)("rejects %s", (_label, value) => {
    expect(() => parseSegmentManifest(value)).toThrow(WalManifestError);
  });
});

describe("file naming", () => {
  it("derives segment and manifest names from a segment id", () => {
    expect(segmentFileName("abc")).toBe("abc.wal.jsonl");
    expect(manifestFileName("abc")).toBe("abc.wal.manifest.json");
  });

  it("recognizes segment file names", () => {
    expect(isSegmentFileName("abc.wal.jsonl")).toBe(true);
    expect(isSegmentFileName(".wal.jsonl")).toBe(false);
    expect(isSegmentFileName("abc.wal.manifest.json")).toBe(false);
    expect(isSegmentFileName("abc.jsonl")).toBe(false);
    expect(segmentIdFromFileName("abc.wal.jsonl")).toBe("abc");
    expect(segmentIdFromFileName("abc.txt")).toBeNull();
  });

  it("builds deterministic, zero-padded segment ids", () => {
    const context = { gatewayEpoch: "epoch", segmentIndex: 7, createdAtMs: 1 };
    expect(defaultSegmentIdFactory(context)).toBe("epoch-000007");
    expect(defaultSegmentIdFactory({ ...context, createdAtMs: 999 })).toBe("epoch-000007");
    expect(defaultSegmentIdFactory({ ...context, segmentIndex: 1_234_567 })).toBe(
      "epoch-1234567",
    );
  });
});

describe("manifest storage", () => {
  it("writes and reads a manifest", async () => {
    const fileSystem = createMemoryFileSystem();
    await writeSegmentManifest(fileSystem, "/wal", manifest);
    expect(await readSegmentManifest(fileSystem, "/wal", manifest.segmentId)).toEqual(manifest);
  });

  it("returns null when a segment has no manifest", async () => {
    const fileSystem = createMemoryFileSystem();
    expect(await readSegmentManifest(fileSystem, "/wal", "missing")).toBeNull();
  });

  it("rejects a manifest whose id does not match its file name", async () => {
    const fileSystem = createMemoryFileSystem();
    fileSystem.poke(`/wal/${manifestFileName("other")}`, encodeSegmentManifest(manifest));
    await expect(readSegmentManifest(fileSystem, "/wal", "other")).rejects.toBeInstanceOf(
      WalManifestError,
    );
  });

  it("rejects a manifest that is not valid JSON", async () => {
    const fileSystem = createMemoryFileSystem();
    fileSystem.poke(
      `/wal/${manifestFileName(manifest.segmentId)}`,
      Buffer.from("{broken", "utf8"),
    );
    await expect(
      readSegmentManifest(fileSystem, "/wal", manifest.segmentId),
    ).rejects.toBeInstanceOf(WalManifestError);
  });

  it("lists manifests ordered by segment index", async () => {
    const fileSystem = createMemoryFileSystem();
    for (const index of [10, 2, 0]) {
      await writeSegmentManifest(fileSystem, "/wal", {
        ...manifest,
        segmentId: `epoch-${String(index).padStart(6, "0")}`,
        segmentIndex: index,
        segmentFileName: `epoch-${String(index).padStart(6, "0")}.wal.jsonl`,
      });
    }
    fileSystem.poke("/wal/unrelated.json", Buffer.from("{}", "utf8"));
    const manifests = await listSegmentManifests(fileSystem, "/wal");
    expect(manifests.map((entry) => entry.segmentIndex)).toEqual([0, 2, 10]);
  });
});
