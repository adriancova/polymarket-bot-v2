/**
 * `WP-050` acceptance 2: "Full segments validate by record count and SHA-256."
 *
 * The positive half is easy and is asserted first. The half that matters is the
 * negative one: a validator that never fails is not a validator, so this suite
 * mutates real segments — a flipped byte, a removed record, a doctored manifest
 * — and requires each mutation to be caught.
 */

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  encodeSegmentManifest,
  manifestFileName,
  scanSegment,
  validateSegment,
} from "@polymarket-bot/storage-wal";
import type { WalSegmentManifest } from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, WAL_DIRECTORY } from "./support/harness.js";

type Built = {
  readonly harness: ReturnType<typeof createFaultHarness>;
  readonly manifest: WalSegmentManifest;
  readonly path: string;
  readonly bytes: Buffer;
};

async function buildClosedSegment(recordCount: number): Promise<Built> {
  const harness = createFaultHarness();
  const writer = await harness.open();
  for (const frame of createTestFrames(recordCount)) {
    writer.enqueue(frame);
  }
  const manifest = await writer.close();
  if (manifest === null) {
    throw new Error("expected a manifest");
  }
  const path = `${WAL_DIRECTORY}/${manifest.segmentFileName}`;
  const bytes = harness.base.peek(path);
  if (bytes === undefined) {
    throw new Error("segment was not written");
  }
  return { harness, manifest, path, bytes };
}

describe("a full segment", () => {
  it.each([1, 2, 17, 64])("validates by record count and SHA-256 (%i records)", async (count) => {
    const { harness, manifest } = await buildClosedSegment(count);
    const report = await validateSegment(harness.fileSystem, WAL_DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.scan.recordCount).toBe(count);
    expect(report.manifest?.recordCount).toBe(count);
    expect(report.scan.footer?.recordCount).toBe(count);
    expect(report.scan.computedSha256).toBe(manifest.segmentSha256);
    expect(report.scan.footer?.segmentSha256).toBe(manifest.segmentSha256);
  });

  it("checksums exactly the header plus the frame lines", async () => {
    const { manifest, bytes } = await buildClosedSegment(6);
    const covered = bytes.subarray(0, manifest.checksummedByteLength);
    const footerLine = bytes.subarray(manifest.checksummedByteLength);
    expect(createHash("sha256").update(covered).digest("hex")).toBe(manifest.segmentSha256);
    expect(footerLine.toString("utf8")).toContain('"record":"footer"');
    expect(manifest.byteSize).toBe(covered.length + footerLine.length);
  });
});

describe("mutations are detected", () => {
  it("catches a single flipped byte anywhere in the checksummed region", async () => {
    const { harness, manifest, path, bytes } = await buildClosedSegment(8);
    const offsets = [0, 40, 120, 300, manifest.checksummedByteLength - 2];
    for (const offset of offsets) {
      const mutated = Buffer.from(bytes);
      const original = mutated[offset];
      if (original === undefined) {
        throw new Error(`offset ${offset} is out of range`);
      }
      mutated[offset] = original ^ 0x01;
      harness.base.poke(path, mutated);

      const report = await validateSegment(harness.fileSystem, WAL_DIRECTORY, manifest.segmentId);
      expect(report.valid, `offset ${offset} went undetected`).toBe(false);
      harness.base.poke(path, bytes);
    }
    expect(
      (await validateSegment(harness.fileSystem, WAL_DIRECTORY, manifest.segmentId)).valid,
    ).toBe(true);
  });

  it("catches a removed record through both the count and the checksum", async () => {
    const { harness, manifest, path, bytes } = await buildClosedSegment(6);
    const lines = bytes.toString("utf8").split("\n");
    lines.splice(3, 1);
    harness.base.poke(path, Buffer.from(lines.join("\n"), "utf8"));

    const report = await validateSegment(harness.fileSystem, WAL_DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
    expect(report.scan.recordCount).toBe(5);
    const codes = report.issues.map((issue) => issue.code);
    expect(codes).toContain("RECORD_COUNT_MISMATCH");
    expect(codes).toContain("CHECKSUM_MISMATCH");
  });

  it("catches a duplicated record", async () => {
    const { harness, manifest, path, bytes } = await buildClosedSegment(4);
    const lines = bytes.toString("utf8").split("\n");
    const duplicated = lines[2];
    if (duplicated === undefined) {
      throw new Error("missing line");
    }
    lines.splice(2, 0, duplicated);
    harness.base.poke(path, Buffer.from(lines.join("\n"), "utf8"));

    const report = await validateSegment(harness.fileSystem, WAL_DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
    expect(report.scan.recordCount).toBe(5);
  });

  it("catches a doctored manifest", async () => {
    const { harness, manifest } = await buildClosedSegment(5);
    const manifestPath = `${WAL_DIRECTORY}/${manifestFileName(manifest.segmentId)}`;

    for (const doctored of [
      { ...manifest, recordCount: manifest.recordCount + 1 },
      { ...manifest, segmentSha256: "0".repeat(64) },
      { ...manifest, byteSize: manifest.byteSize + 10 },
      { ...manifest, checksummedByteLength: manifest.checksummedByteLength - 1 },
    ]) {
      harness.base.poke(manifestPath, encodeSegmentManifest(doctored));
      const report = await validateSegment(harness.fileSystem, WAL_DIRECTORY, manifest.segmentId);
      expect(report.valid).toBe(false);
    }
  });

  it("catches an append after the footer", async () => {
    const { harness, manifest, path, bytes } = await buildClosedSegment(3);
    harness.base.poke(path, Buffer.concat([bytes, Buffer.from("{}\n", "utf8")]));
    const report = await validateSegment(harness.fileSystem, WAL_DIRECTORY, manifest.segmentId);
    expect(report.valid).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain("RECORD_AFTER_FOOTER");
  });

  it("catches a footer whose declared checksum was rewritten", async () => {
    const { harness, manifest, path, bytes } = await buildClosedSegment(3);
    const text = bytes.toString("utf8");
    const rewritten = text.replace(manifest.segmentSha256, "f".repeat(64));
    expect(rewritten).not.toBe(text);
    harness.base.poke(path, Buffer.from(rewritten, "utf8"));

    const scan = await scanSegment(harness.fileSystem, path, { onIssue: "collect" });
    expect(scan.issues.map((issue) => issue.code)).toContain("CHECKSUM_MISMATCH");
  });
});
