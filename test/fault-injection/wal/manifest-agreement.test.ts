/**
 * Footer/manifest/header agreement, field by field.
 *
 * `wal-format.md` §6 says "when both exist they must agree", and §7 makes a
 * manifest the thing that decides whether a segment is verified. Round-1 review
 * found that agreement was only checked for the record count, the checksum, the
 * checksummed length, and the byte size — so a doctored `gatewayEpoch`,
 * `segmentIndex`, `firstIngestSeq`, `lastReceivedAt`, `closeReason`,
 * `footerPresent`, or `truncatedTailBytes` all validated cleanly.
 *
 * That matters because those fields are not decoration: `WP-130` carries the
 * epoch and the `ingestSeq` range into dataset manifests (§12.5), so an edited
 * range silently mislabels which data a dataset contains while every digest
 * still matches. A checksum protects the bytes; only a cross-check protects the
 * claims made *about* the bytes.
 */

import { describe, expect, it } from "vitest";

import { manifestFileName, validateSegment } from "@polymarket-bot/storage-wal";
import type { SegmentIssueCode, WalSegmentManifest } from "@polymarket-bot/storage-wal";
import { createTestFrames } from "@polymarket-bot/storage-wal/testing";

import { createFaultHarness, WAL_DIRECTORY } from "./support/harness.js";

type Built = {
  readonly harness: ReturnType<typeof createFaultHarness>;
  readonly manifest: WalSegmentManifest;
  readonly manifestPath: string;
};

async function buildClosedSegment(recordCount = 4): Promise<Built> {
  const harness = createFaultHarness();
  const writer = await harness.open();
  for (const frame of createTestFrames(recordCount)) {
    writer.enqueue(frame);
  }
  const manifest = await writer.close();
  if (manifest === null) {
    throw new Error("expected a manifest");
  }
  return {
    harness,
    manifest,
    manifestPath: `${WAL_DIRECTORY}/${manifestFileName(manifest.segmentId)}`,
  };
}

/**
 * Rewrite one manifest field and revalidate.
 *
 * The document is written field by field rather than through
 * `encodeSegmentManifest` so that a field's *value* is doctored without the
 * encoder having a chance to normalize it.
 */
async function validateWithField(
  built: Built,
  field: string,
  value: unknown,
): Promise<readonly SegmentIssueCode[]> {
  const original = { ...built.manifest } as Record<string, unknown>;
  built.harness.base.poke(
    built.manifestPath,
    Buffer.from(`${JSON.stringify({ ...original, [field]: value }, null, 2)}\n`, "utf8"),
  );
  const report = await validateSegment(
    built.harness.fileSystem,
    WAL_DIRECTORY,
    built.manifest.segmentId,
  );
  expect(report.valid, `a doctored ${field} was accepted as valid`).toBe(false);
  return report.issues.map((issue) => issue.code);
}

describe("a doctored manifest field", () => {
  it("is caught for every field the footer or the header also carries", async () => {
    const built = await buildClosedSegment();
    const cases: readonly (readonly [string, unknown, SegmentIssueCode])[] = [
      ["gatewayEpoch", "0190a3e0-0000-7000-8000-00000000dead", "MANIFEST_HEADER_DISAGREE"],
      ["segmentIndex", 42, "MANIFEST_HEADER_DISAGREE"],
      ["createdAt", "1999-01-01T00:00:00.000Z", "MANIFEST_HEADER_DISAGREE"],
      ["closedAt", "1999-01-01T00:00:00.000Z", "FOOTER_MANIFEST_DISAGREE"],
      ["closeReason", "recovery", "FOOTER_MANIFEST_DISAGREE"],
    ];
    for (const [field, value, expectedCode] of cases) {
      const codes = await validateWithField(built, field, value);
      expect(codes, `${field} produced ${codes.join(", ")}`).toContain(expectedCode);
    }
  });

  it("is caught for every field derivable from the records themselves", async () => {
    const built = await buildClosedSegment();
    const cases: readonly (readonly [string, unknown])[] = [
      ["firstIngestSeq", "999"],
      ["lastIngestSeq", "999"],
      ["firstReceivedAt", "1999-01-01T00:00:00.000Z"],
      ["lastReceivedAt", "1999-01-01T00:00:00.000Z"],
      ["footerPresent", false],
    ];
    for (const [field, value] of cases) {
      const codes = await validateWithField(built, field, value);
      expect(codes, `${field} produced ${codes.join(", ")}`).toContain("MANIFEST_CONTENT_DISAGREE");
    }
  });

  it("is caught when the manifest contradicts itself", async () => {
    const built = await buildClosedSegment();
    // A cleanly closed segment carries a footer, so nothing was truncated.
    expect(await validateWithField(built, "truncatedTailBytes", 12_345)).toContain(
      "MANIFEST_INCONSISTENT",
    );
    // The file name must follow from the id.
    expect(await validateWithField(built, "segmentFileName", "somewhere-else.wal.jsonl")).toContain(
      "MANIFEST_INCONSISTENT",
    );
    // A digest cannot cover more bytes than the file has.
    expect(
      await validateWithField(built, "checksummedByteLength", built.manifest.byteSize + 1),
    ).toContain("MANIFEST_INCONSISTENT");
  });

  it("is caught when the id's ordinal and the declared index disagree", async () => {
    const built = await buildClosedSegment();
    // The default factory encodes the ordinal in the id, so the two must agree.
    // A factory that encodes nothing is not second-guessed.
    const codes = await validateWithField(built, "segmentIndex", 7);
    expect(codes).toContain("MANIFEST_INCONSISTENT");
    expect(codes).toContain("MANIFEST_HEADER_DISAGREE");
  });

  it("keeps a genuine manifest valid", async () => {
    const built = await buildClosedSegment(9);
    const report = await validateSegment(
      built.harness.fileSystem,
      WAL_DIRECTORY,
      built.manifest.segmentId,
    );
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });
});

describe("a recovery-written manifest", () => {
  it("agrees with the segment it describes", async () => {
    // Crash after the frames but before any close: recovery writes the sidecar,
    // and every cross-check must still pass.
    const harness = createFaultHarness();
    const writer = await harness.open();
    for (const frame of createTestFrames(5)) {
      writer.enqueue(frame);
    }
    await writer.flush();

    const reopened = await harness.open();
    const manifests = await reopened.listManifests();
    expect(manifests).toHaveLength(1);
    const report = await validateSegment(
      harness.fileSystem,
      WAL_DIRECTORY,
      manifests[0]?.segmentId ?? "",
    );
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.manifest?.footerPresent).toBe(false);
    expect(report.manifest?.closeReason).toBe("recovery");
    await reopened.close();
  });

  it("agrees after a torn append is truncated", async () => {
    const harness = createFaultHarness({
      onAppend: (call, _path, bytes) =>
        call === 2
          ? { writeBytes: Math.floor(bytes.length / 2), error: new Error("SIGKILL mid-append") }
          : undefined,
    });
    const writer = await harness.open();
    for (const frame of createTestFrames(5)) {
      writer.enqueue(frame);
    }
    await writer.drain().catch(() => undefined);

    const reopened = await harness.open();
    const manifests = await reopened.listManifests();
    expect(manifests).toHaveLength(1);
    // Truncation happened, so the manifest must say so and must not claim a
    // footer — the pair of facts the internal consistency check enforces.
    expect(manifests[0]?.truncatedTailBytes).toBeGreaterThan(0);
    expect(manifests[0]?.footerPresent).toBe(false);
    const report = await validateSegment(
      harness.fileSystem,
      WAL_DIRECTORY,
      manifests[0]?.segmentId ?? "",
    );
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
    await reopened.close();
  });
});
