/**
 * What compaction refuses, on real files written by the real WAL writer.
 *
 * ADR-004 §3: mid-file corruption is a data-quality incident, not a recovery
 * case. Every refusal below leaves the bytes exactly as found and reports the
 * reason into the dataset manifest's exclusion list, which is the mechanism by
 * which "the affected range is excluded from dataset manifests" (§10.2, §12.5)
 * actually happens.
 */

import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compactWalDirectory,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
  systemCompactionClock,
} from "@polymarket-bot/storage-parquet";
import type { CompactionResult } from "@polymarket-bot/storage-parquet";

import { createWorkspace, frame, recordFrames } from "./context.js";
import type { TemporaryWorkspace } from "./context.js";

let workspace: TemporaryWorkspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

/**
 * Record several segments and return the last one (the "victim" a test damages)
 * plus every other one, which must still verify.
 *
 * The split is by position rather than by a fixed count because rotation is the
 * writer's decision, not this test's: asserting "exactly two segments" would
 * couple the suite to a byte budget it does not own.
 */
async function recordSegments(): Promise<{
  readonly victim: string;
  readonly survivors: readonly string[];
}> {
  const frames = [1, 2, 3, 4].map((seq) =>
    frame({ ingestSeq: seq, payloadUtf8: `{"event_type":"book","n":${seq}}` }),
  );
  const written = await recordFrames(workspace.walDirectoryPath, frames, {
    maxSegmentBytes: 700,
  });
  expect(written.manifests.length).toBeGreaterThan(1);
  const ids = written.manifests.map((manifest) => manifest.segmentId).sort();
  const victim = ids[ids.length - 1];
  if (victim === undefined) {
    throw new Error("expected at least one segment");
  }
  return { victim, survivors: ids.slice(0, -1) };
}

async function compact(): Promise<CompactionResult> {
  return await compactWalDirectory({
    walDirectoryPath: workspace.walDirectoryPath,
    datasetId: "ds-refusal",
    objectKeyPrefix: "datasets/ds-refusal",
    objectStore: fileSystemObjectStore(workspace.objectStoreRoot),
    fileSystem: nodeCompactionFileSystem(),
    clock: systemCompactionClock(),
  });
}

function issueCodes(result: CompactionResult, segmentId: string): readonly string[] {
  const entry = result.manifest.excludedSegments.find((e) => e.segmentId === segmentId);
  return entry?.issues.map((issue) => issue.code) ?? [];
}

describe("refusal", () => {
  it("ignores a segment whose sidecar manifest is missing", async () => {
    // `wal-format.md` §2: no manifest, no exposure. This is the state a
    // crash-abandoned segment is left in, and the compactor must not even read
    // it, let alone put it in a dataset.
    const { victim, survivors } = await recordSegments();
    await rm(join(workspace.walDirectoryPath, `${victim}.wal.manifest.json`));

    const result = await compact();
    expect(result.verifiedSegmentIds).toStrictEqual(survivors);
    expect(result.manifest.excludedSegments).toStrictEqual([]);
    // The bytes are still there, untouched, waiting for WAL recovery.
    await expect(
      stat(join(workspace.walDirectoryPath, `${victim}.wal.jsonl`)),
    ).resolves.toBeDefined();
  });

  it("refuses a torn segment and does not truncate it", async () => {
    const { victim, survivors } = await recordSegments();
    const path = join(workspace.walDirectoryPath, `${victim}.wal.jsonl`);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from('{"gatewayEpoch":"0190')]));

    const result = await compact();
    expect(result.verifiedSegmentIds).toStrictEqual(survivors);
    expect(issueCodes(result, victim)).toContain("RECORD_AFTER_FOOTER");
    expect(await readFile(path)).toStrictEqual(
      Buffer.concat([original, Buffer.from('{"gatewayEpoch":"0190')]),
    );
  });

  it("refuses a mid-file corruption without repairing it", async () => {
    const { victim, survivors } = await recordSegments();
    const path = join(workspace.walDirectoryPath, `${victim}.wal.jsonl`);
    const lines = (await readFile(path, "utf8")).split("\n");
    lines[1] = '{"gatewayEpoch":"broken"';
    await writeFile(path, lines.join("\n"));

    const result = await compact();
    expect(result.verifiedSegmentIds).toStrictEqual(survivors);
    expect(issueCodes(result, victim)).toContain("RECORD_INVALID");
  });

  it("refuses a same-width byte edit through the segment checksum", async () => {
    const { victim, survivors } = await recordSegments();
    const path = join(workspace.walDirectoryPath, `${victim}.wal.jsonl`);
    const text = await readFile(path, "utf8");
    await writeFile(path, text.replace("conn-1", "conn-2"));

    const result = await compact();
    expect(result.verifiedSegmentIds).toStrictEqual(survivors);
    expect(issueCodes(result, victim)).toContain("CHECKSUM_MISMATCH");
  });

  it("refuses a doctored sidecar whose digests still verify", async () => {
    // §6.3: a checksum protects the bytes, not the claims about them — and the
    // claims are what a dataset manifest copies.
    const { victim, survivors } = await recordSegments();
    const path = join(workspace.walDirectoryPath, `${victim}.wal.manifest.json`);
    const document = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    document["firstIngestSeq"] = "999";
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`);

    const result = await compact();
    expect(result.verifiedSegmentIds).toStrictEqual(survivors);
    expect(issueCodes(result, victim)).toContain("MANIFEST_CONTENT_DISAGREE");
  });

  it("refuses a segment whose file was removed but whose sidecar remains", async () => {
    const { victim, survivors } = await recordSegments();
    await rm(join(workspace.walDirectoryPath, `${victim}.wal.jsonl`));

    const result = await compact();
    expect(result.verifiedSegmentIds).toStrictEqual(survivors);
    expect(issueCodes(result, victim)).toStrictEqual(["SEGMENT_MISSING"]);
  });

  it("still produces a usable dataset from the segments that did verify", async () => {
    const { victim, survivors } = await recordSegments();
    const path = join(workspace.walDirectoryPath, `${victim}.wal.jsonl`);
    await writeFile(path, (await readFile(path, "utf8")).replace("conn-1", "conn-2"));

    const result = await compact();
    // A refusal is data, not a crash: the good segment is compacted, and the
    // bad one is named in the manifest with its reason.
    expect(result.rowsWritten).toBeGreaterThan(0);
    expect(result.manifest.excludedSegments).toHaveLength(1);
    expect(result.manifest.objects).toHaveLength(survivors.length);
    expect(result.manifest.segments.map((segment) => segment.segmentId)).toStrictEqual(
      survivors,
    );
  });
});
