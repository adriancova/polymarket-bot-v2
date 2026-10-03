/**
 * The one suite in this package that touches a real disk.
 *
 * The rest of the tests use the in-memory double, which is what makes them fast
 * and deterministic — but a filesystem port whose only implementation is a
 * fiction proves nothing. These tests run the same writer, reader, and recovery
 * paths against `node:fs` in a temporary directory.
 */

import { mkdir, mkdtemp, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { segmentFileName } from "./manifest.js";
import { nodeWalFileSystem } from "./node-file-system.js";
import { readSegmentRecords, validateSegment, validateWalDirectory } from "./reader.js";
import { createManualClock } from "./testing/manual-clock.js";
import { createTestFrame, createTestFrames, TEST_GATEWAY_EPOCH } from "./testing/frames.js";
import { openWalWriter } from "./writer.js";

let directory = "";

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "polymarket-wal-test-"));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("node filesystem port", () => {
  it("records and reads back a segment on a real disk", async () => {
    const fileSystem = nodeWalFileSystem();
    const writer = await openWalWriter({
      directoryPath: join(directory, "wal"),
      gatewayEpoch: TEST_GATEWAY_EPOCH,
      fileSystem,
      clock: createManualClock(),
    });
    const payloads = ["PING", '{"event_type":"book"}', "🚀", ""];
    payloads.forEach((payload, index) => {
      writer.enqueue(createTestFrame({ ingestSeq: index + 1, payloadUtf8: payload }));
    });
    const manifest = await writer.close();
    expect(manifest).not.toBeNull();

    const walDirectory = join(directory, "wal");
    const report = await validateSegment(fileSystem, walDirectory, manifest?.segmentId ?? "");
    expect(report.issues).toEqual([]);
    expect(report.valid).toBe(true);

    const { records } = await readSegmentRecords(
      fileSystem,
      join(walDirectory, segmentFileName(manifest?.segmentId ?? "")),
    );
    expect(records.map((record) => record.payloadUtf8)).toEqual(payloads);
  });

  it("leaves no temporary manifest file behind", async () => {
    const fileSystem = nodeWalFileSystem();
    const walDirectory = join(directory, "wal");
    const writer = await openWalWriter({
      directoryPath: walDirectory,
      gatewayEpoch: TEST_GATEWAY_EPOCH,
      fileSystem,
      clock: createManualClock(),
    });
    writer.enqueue(createTestFrame());
    await writer.close();
    const names = await fileSystem.listFileNames(walDirectory);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(names).toHaveLength(2);
  });

  it("recovers a real half-written record after a simulated kill", async () => {
    const fileSystem = nodeWalFileSystem();
    const walDirectory = join(directory, "wal");
    const clock = createManualClock();
    const first = await openWalWriter({
      directoryPath: walDirectory,
      gatewayEpoch: TEST_GATEWAY_EPOCH,
      fileSystem,
      clock,
    });
    for (const frame of createTestFrames(3)) {
      first.enqueue(frame);
    }
    await first.flush();
    const segmentId = first.activeSegmentId ?? "";
    const segmentPath = join(walDirectory, segmentFileName(segmentId));
    const goodBytes = await readFile(segmentPath);

    // The process dies here: a partial record reached the file, and neither the
    // footer nor the manifest was ever written.
    const partial = Buffer.from('{"gatewayEpoch":"0190a3e0-0000-7000-8000-00', "utf8");
    await writeFile(segmentPath, Buffer.concat([goodBytes, partial]));

    const second = await openWalWriter({
      directoryPath: walDirectory,
      gatewayEpoch: TEST_GATEWAY_EPOCH,
      fileSystem,
      clock,
    });
    expect(second.recovery.truncatedSegmentCount).toBe(1);
    expect(second.recovery.truncatedBytes).toBe(partial.length);
    expect((await readFile(segmentPath)).equals(goodBytes)).toBe(true);

    second.enqueue(createTestFrame({ ingestSeq: 4 }));
    await second.close();

    const reports = await validateWalDirectory(fileSystem, walDirectory);
    expect(reports).toHaveLength(2);
    expect(reports.every((report) => report.valid)).toBe(true);
    const total = reports.reduce((sum, report) => sum + report.scan.recordCount, 0);
    expect(total).toBe(4);
  });

  it("reports a missing file as null rather than throwing", async () => {
    const fileSystem = nodeWalFileSystem();
    expect(await fileSystem.fileByteLength(join(directory, "nope"))).toBeNull();
    expect(await fileSystem.listFileNames(join(directory, "nope-dir"))).toEqual([]);
  });

  it("creates nested directories", async () => {
    const fileSystem = nodeWalFileSystem();
    const nested = join(directory, "a", "b", "c");
    await fileSystem.ensureDirectory(nested);
    expect((await stat(nested)).isDirectory()).toBe(true);
  });

  it("reads a range that runs past the end of the file", async () => {
    const fileSystem = nodeWalFileSystem();
    const path = join(directory, "sample");
    await writeFile(path, "abcdef");
    const handle = await fileSystem.openRead(path);
    try {
      expect(Buffer.from(await handle.read(0, 3)).toString("utf8")).toBe("abc");
      expect(Buffer.from(await handle.read(4, 100)).toString("utf8")).toBe("ef");
      expect(Buffer.from(await handle.read(10, 5)).toString("utf8")).toBe("");
      expect(Buffer.from(await handle.read(0, 0)).length).toBe(0);
    } finally {
      await handle.close();
    }
  });

  it("appends without rewriting earlier bytes", async () => {
    const fileSystem = nodeWalFileSystem();
    const path = join(directory, "append-target");
    const handle = await fileSystem.openAppend(path);
    try {
      await handle.append(Buffer.from("one\n", "utf8"));
      await handle.sync();
      await handle.append(Buffer.from("two\n", "utf8"));
      await handle.sync();
    } finally {
      await handle.close();
    }
    expect((await readFile(path)).toString("utf8")).toBe("one\ntwo\n");
  });

  it("lists the directories directly inside a directory, not files or links, and none for a missing one", async () => {
    const fileSystem = nodeWalFileSystem();
    const root = join(directory, "root");
    await mkdir(join(root, "epoch-a", "nested"), { recursive: true });
    await mkdir(join(root, "epoch-b"));
    await writeFile(join(root, "market-lifecycle-ledger.json"), "{}");
    await symlink(join(root, "epoch-a"), join(root, "a-link"));
    expect([...(await fileSystem.listDirectoryNames?.(root) ?? [])].sort()).toEqual(["epoch-a", "epoch-b"]);
    expect(await fileSystem.listDirectoryNames?.(join(root, "absent"))).toEqual([]);
  });

  it("a writer whose threshold covers a WAL root counts every epoch on a real disk, and gives back what is deleted", async () => {
    const fileSystem = nodeWalFileSystem();
    const root = join(directory, "wal-root");
    const epochA = "0190a3e0-0000-7000-8000-00000000000a";
    const epochB = "0190a3e0-0000-7000-8000-00000000000b";
    const first = await openWalWriter({
      directoryPath: join(root, epochA),
      gatewayEpoch: epochA,
      fileSystem,
      clock: createManualClock(),
      maxTotalBytes: 1_000_000,
      capacityRootPath: root,
      maxSegmentBytes: 1_500,
    });
    for (const frame of createTestFrames(8, { gatewayEpoch: epochA })) first.enqueue(frame);
    await first.close();
    const manifests = await first.listManifests();
    const onDisk = async (): Promise<number> => {
      let total = 0;
      for (const epoch of [epochA, epochB]) {
        for (const name of await fileSystem.listFileNames(join(root, epoch))) {
          if (name.endsWith(".wal.jsonl")) total += (await stat(join(root, epoch, name))).size;
        }
      }
      return total;
    };

    const second = await openWalWriter({
      directoryPath: join(root, epochB),
      gatewayEpoch: epochB,
      fileSystem,
      clock: createManualClock(),
      maxTotalBytes: 1_000_000,
      capacityRootPath: root,
    });
    expect(second.metrics().totalSegmentBytes).toBe(await onDisk());
    const [oldest] = manifests;
    if (oldest === undefined) throw new Error("no sealed segment");
    await unlink(join(root, epochA, oldest.segmentFileName));
    await second.tick();
    expect(second.metrics().capacityRelievedBytes).toBe(oldest.byteSize);
    expect(second.metrics().totalSegmentBytes).toBe(await onDisk());
    // The whole earlier epoch removed, directory and all: every byte back.
    await rm(join(root, epochA), { recursive: true, force: true });
    await second.tick();
    expect(second.metrics().totalSegmentBytes).toBe(await onDisk());
    expect(second.metrics().totalSegmentBytes).toBe(0);
    await second.close();
  });
});
