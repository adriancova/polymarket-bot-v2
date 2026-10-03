/**
 * `WALCAP-1` (closing `STORAGE1-MAXBYTES`, finding J10 of `STORAGE-1`):
 * `maxTotalBytes` after raw-WAL expiry.
 *
 * ADR-028 Decision 5: the threshold is a hard stop. Reaching it refuses new
 * frames, never deletes or overwrites, and expiry never runs early to make
 * room. What changed is what the writer counts: a ledger of the segment files
 * under the WAL root (`capacity-ledger.ts`), re-derived on every `tick()`, so
 *
 * - a segment that expiry deleted stops counting, and a writer refused at its
 *   cap records again (the relief J10 asked for);
 * - an earlier epoch's segments under the root count, so a restart cannot
 *   start the count from zero (each epoch writes its own directory);
 * - nothing ever lowers the count but a direct read that finds a file gone,
 *   or the writer's own truncation of a torn tail on its fault path, recorded
 *   at the truncated size (r2, N-4), so it never drops below the disk: not
 *   under concurrent appends, a deletion during a rotation, a stale or partial
 *   listing, or a failed read.
 *
 * Every test checks the two invariants that matter after each step: the
 * segment bytes on disk under the root never exceed `maxTotalBytes`, and the
 * writer's count is never below them. "After each step" means with no write
 * of the writer in flight; `capacity-in-flight.test.ts` (round 1) covers
 * drains suspended mid-write, failed writes, and the count at open.
 */

import { describe, expect, it } from "vitest";

import { WalConfigurationError } from "./errors.js";
import { listSegmentManifests, manifestFileName } from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import type { WalCapacityRescanEvent, WalFileSystem } from "./ports.js";
import { createTestFrame } from "./testing/frames.js";
import { createManualClock } from "./testing/manual-clock.js";
import type { ManualClock } from "./testing/manual-clock.js";
import { createMemoryFileSystem } from "./testing/memory-file-system.js";
import type { MemoryFileSystem } from "./testing/memory-file-system.js";
import { openWalWriter } from "./writer.js";
import type { WalWriter, WalWriterOptions } from "./writer.js";

const ROOT = "/wal";
const EPOCH_A = "0190a3e0-0000-7000-8000-00000000000a";
const EPOCH_B = "0190a3e0-0000-7000-8000-00000000000b";
const EPOCH_C = "0190a3e0-0000-7000-8000-00000000000c";
const CAP = 12_000;
const SEGMENT_BYTES = 2_000;

/** Segment bytes on disk under the root: the quantity `maxTotalBytes` bounds. */
function onDisk(fileSystem: MemoryFileSystem): number {
  let total = 0;
  for (const [path, bytes] of fileSystem.files) {
    if (path.startsWith(`${ROOT}/`) && path.endsWith(".wal.jsonl")) {
      total += bytes.length;
    }
  }
  return total;
}

function expectInvariants(writer: WalWriter, fileSystem: MemoryFileSystem, cap = CAP): void {
  const disk = onDisk(fileSystem);
  expect(disk, "segment bytes on disk under the root").toBeLessThanOrEqual(cap);
  expect(writer.metrics().totalSegmentBytes, "the writer's count against the disk").toBeGreaterThanOrEqual(disk);
}

function directoryOf(epoch: string): string {
  return `${ROOT}/${epoch}`;
}

async function openEpoch(
  fileSystem: WalFileSystem,
  clock: ManualClock,
  epoch: string,
  overrides: Partial<WalWriterOptions> = {},
): Promise<WalWriter> {
  return openWalWriter({
    directoryPath: directoryOf(epoch),
    gatewayEpoch: epoch,
    fileSystem,
    clock,
    maxTotalBytes: CAP,
    capacityRootPath: ROOT,
    maxSegmentBytes: SEGMENT_BYTES,
    // No time rotation here: `capacity-in-flight.test.ts` holds the cap
    // against it (r2, TR).
    maxSegmentAgeMs: 1_000_000_000,
    ...overrides,
  });
}

type Feeder = { next(epoch: string): ReturnType<typeof createTestFrame> };

function feeder(): Feeder {
  let seq = 0;
  return {
    next(epoch: string) {
      seq += 1;
      return createTestFrame({ gatewayEpoch: epoch, ingestSeq: seq, payloadUtf8: `{"n":${String(seq)}}` });
    },
  };
}

/** Offer frames one at a time, draining between, until the cap refuses one. */
async function fillToCap(
  writer: WalWriter,
  fileSystem: MemoryFileSystem,
  frames: Feeder,
  epoch: string,
  limit = 200,
): Promise<number> {
  let accepted = 0;
  for (let index = 0; index < limit; index += 1) {
    const result = writer.enqueue(frames.next(epoch));
    if (!result.accepted) {
      expect(result.reason).toBe("capacity-exceeded");
      return accepted;
    }
    accepted += 1;
    await writer.drain();
    expectInvariants(writer, fileSystem);
  }
  throw new Error(`the cap never refused within ${String(limit)} frames`);
}

/** The oldest sealed segment of a directory, read synchronously from the memory filesystem. */
function oldestSealedPath(fileSystem: MemoryFileSystem, directory: string, except: string): string | undefined {
  const sealed: string[] = [];
  for (const path of fileSystem.files.keys()) {
    if (!path.startsWith(`${directory}/`) || !path.endsWith(".wal.jsonl")) continue;
    const manifestPath = path.replace(/\.wal\.jsonl$/u, ".wal.manifest.json");
    if (manifestPath !== except && fileSystem.files.has(manifestPath)) sealed.push(path);
  }
  return sealed.sort()[0];
}

/** What raw-WAL expiry does to a sealed segment: the segment, then its sidecar. */
function expire(fileSystem: MemoryFileSystem, directory: string, manifest: WalSegmentManifest): number {
  const segmentPath = `${directory}/${manifest.segmentFileName}`;
  const bytes = fileSystem.peek(segmentPath)?.length ?? 0;
  fileSystem.files.delete(segmentPath);
  fileSystem.files.delete(`${directory}/${manifestFileName(manifest.segmentId)}`);
  return bytes;
}

describe("relief after expiry (J10)", () => {
  it("a writer refused at its cap records again once expiry deletes a sealed segment, and never past the cap", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const writer = await openEpoch(fileSystem, clock, EPOCH_A);

    const accepted = await fillToCap(writer, fileSystem, frames, EPOCH_A);
    expect(accepted).toBeGreaterThan(5);
    expect(writer.metrics().capacityReached).toBe(true);

    // At the cap with nothing deleted, a re-derivation finds nothing to give
    // back: still refused, and nothing on disk was touched to make room.
    const before = fileSystem.snapshot();
    await writer.tick();
    expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(false);
    expect(fileSystem.snapshot()).toStrictEqual(before);
    expect(fileSystem.stats.truncations).toBe(0);

    // Expiry deletes the oldest sealed segment. Until the next re-derivation
    // the writer still counts it: refused, which is the safe direction.
    const [oldest] = await listSegmentManifests(fileSystem, directoryOf(EPOCH_A));
    if (oldest === undefined) throw new Error("no sealed segment");
    const freed = expire(fileSystem, directoryOf(EPOCH_A), oldest);
    expect(freed).toBeGreaterThan(0);
    expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(false);
    expectInvariants(writer, fileSystem);

    const countBefore = writer.metrics().totalSegmentBytes;
    await writer.tick();
    expect(writer.metrics().totalSegmentBytes).toBe(countBefore - freed);
    expect(writer.metrics().capacityRelievedBytes).toBe(freed);

    // Recording resumes, and stops again at the cap, never past it.
    const resumed = await fillToCap(writer, fileSystem, frames, EPOCH_A);
    expect(resumed).toBeGreaterThan(0);
    expect(writer.metrics().capacityReached).toBe(true);
    expectInvariants(writer, fileSystem);
    await writer.close();
    expectInvariants(writer, fileSystem);
  });

  it("gives back exactly the bytes of the files found gone, and the count then equals the disk", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const events: WalCapacityRescanEvent[] = [];
    const writer = await openEpoch(fileSystem, clock, EPOCH_A, {
      observer: { onCapacityRescan: (event) => events.push(event) },
    });
    await fillToCap(writer, fileSystem, frames, EPOCH_A);
    const manifests = await listSegmentManifests(fileSystem, directoryOf(EPOCH_A));
    expect(manifests.length).toBeGreaterThan(2);
    const freed =
      expire(fileSystem, directoryOf(EPOCH_A), manifests[0] as WalSegmentManifest) +
      expire(fileSystem, directoryOf(EPOCH_A), manifests[1] as WalSegmentManifest);

    await writer.tick();
    const last = events.at(-1);
    expect(last).toMatchObject({ outcome: "counted", relievedBytes: freed, segmentsForgotten: 2 });
    // The open segment included: the ledger holds what is on disk, no more.
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(fileSystem));
    await writer.close();
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(fileSystem));
  });

  it("re-derives with no segment open, which is how a writer at its cap usually waits", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const writer = await openEpoch(fileSystem, clock, EPOCH_A);
    await fillToCap(writer, fileSystem, frames, EPOCH_A);
    await writer.rotate();
    expect(writer.activeSegmentId).toBeNull();
    const [oldest] = await listSegmentManifests(fileSystem, directoryOf(EPOCH_A));
    const freed = expire(fileSystem, directoryOf(EPOCH_A), oldest as WalSegmentManifest);
    await writer.tick();
    expect(writer.metrics().capacityRelievedBytes).toBe(freed);
    expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(true);
    await writer.close();
    expectInvariants(writer, fileSystem);
  });
});

describe("the count covers the WAL root, so a restart starts from the disk", () => {
  it("counts an earlier epoch's segments: the next epoch cannot write a second cap's worth", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const first = await openEpoch(fileSystem, clock, EPOCH_A);
    await fillToCap(first, fileSystem, frames, EPOCH_A);
    await first.close();
    const afterFirst = onDisk(fileSystem);

    const second = await openEpoch(fileSystem, clock, EPOCH_B);
    expect(second.metrics().totalSegmentBytes).toBe(afterFirst);
    expect(second.enqueue(frames.next(EPOCH_B)).accepted).toBe(false);
    expectInvariants(second, fileSystem);

    // Expiry frees the first epoch's oldest segment; the second epoch records.
    const [oldest] = await listSegmentManifests(fileSystem, directoryOf(EPOCH_A));
    expire(fileSystem, directoryOf(EPOCH_A), oldest as WalSegmentManifest);
    await second.tick();
    expect(await fillToCap(second, fileSystem, frames, EPOCH_B)).toBeGreaterThan(0);
    await second.close();
    expectInvariants(second, fileSystem);
  });

  it("counts a crashed epoch's unsealed segment, footer-less and unmanifested", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const crashed = await openEpoch(fileSystem, clock, EPOCH_A);
    for (let index = 0; index < 6; index += 1) {
      expect(crashed.enqueue(frames.next(EPOCH_A)).accepted).toBe(true);
      await crashed.drain();
    }
    // The process dies here: no footer, no manifest for the open segment.
    const left = onDisk(fileSystem);
    expect(left).toBeGreaterThan(0);

    const next = await openEpoch(fileSystem, clock, EPOCH_B);
    expect(next.metrics().totalSegmentBytes).toBe(left);
    await fillToCap(next, fileSystem, frames, EPOCH_B);
    await next.close();
    expectInvariants(next, fileSystem);
  });

  it("an epoch directory removed whole stops counting; one still there keeps counting", async () => {
    const base = createMemoryFileSystem();
    let removed = false;
    // The memory filesystem keeps a directory it was asked to ensure; on a
    // real disk `rm -r` removes it from the root's listing too.
    const fileSystem = hookedFileSystem(base, {
      directories: (_directory, names) => (removed ? names.filter((name) => name !== EPOCH_A) : names),
    });
    const clock = createManualClock();
    const frames = feeder();
    const first = await openEpoch(fileSystem, clock, EPOCH_A);
    for (let index = 0; index < 8; index += 1) {
      first.enqueue(frames.next(EPOCH_A));
      await first.drain();
    }
    await first.close();
    const second = await openEpoch(fileSystem, clock, EPOCH_B);
    const counted = second.metrics().totalSegmentBytes;
    expect(counted).toBeGreaterThan(0);
    for (const path of [...base.files.keys()]) {
      if (path.startsWith(`${directoryOf(EPOCH_A)}/`)) base.files.delete(path);
    }
    removed = true;
    await second.tick();
    expect(second.metrics().capacityRelievedBytes).toBe(counted);
    expect(second.metrics().totalSegmentBytes).toBe(0);
    await second.close();
  });

  it("a segment another process writes under the root after the open is counted by the next re-derivation", async () => {
    // One writer per WAL root is a premise (ADR-025 D10); if it is broken, the
    // count still catches up on the next tick rather than never.
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const writer = await openEpoch(fileSystem, clock, EPOCH_A);
    const foreign = await openEpoch(fileSystem, clock, EPOCH_B, { maxTotalBytes: null });
    for (let index = 0; index < 5; index += 1) {
      foreign.enqueue(frames.next(EPOCH_B));
      await foreign.drain();
    }
    await foreign.close();
    // Segment files written straight into the root count as well.
    fileSystem.poke(`${ROOT}/0190a3e0-0000-7000-8000-00000000000d-000000.wal.jsonl`, Buffer.from("x".repeat(100)));
    expect(writer.metrics().totalSegmentBytes).toBe(0);
    await writer.tick();
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(fileSystem));
    await writer.close();
  });

  it("without a capacity root, the threshold covers the writer's own directory, as before", async () => {
    const fileSystem = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const first = await openEpoch(fileSystem, clock, EPOCH_A);
    await fillToCap(first, fileSystem, frames, EPOCH_A);
    await first.close();
    const second = await openWalWriter({
      directoryPath: directoryOf(EPOCH_B),
      gatewayEpoch: EPOCH_B,
      fileSystem,
      clock,
      maxTotalBytes: CAP,
      maxSegmentBytes: SEGMENT_BYTES,
    });
    expect(second.metrics().totalSegmentBytes).toBe(0);
    await second.close();
  });
});

/** A memory filesystem with hooks on the reads a re-derivation makes. */
function hookedFileSystem(
  base: MemoryFileSystem,
  hooks: {
    beforeList?: (directory: string) => Promise<void> | void;
    list?: (directory: string, names: readonly string[]) => readonly string[];
    /** Rewrites a directory listing (the in-memory filesystem keeps an ensured directory forever). */
    directories?: (directory: string, names: readonly string[]) => readonly string[];
    beforeLength?: (path: string) => Promise<void> | void;
    /** Runs after the length was read and before it is returned: a late answer. */
    afterLength?: (path: string, length: number | null) => Promise<void> | void;
    afterWholeFile?: (path: string) => void;
  },
): MemoryFileSystem {
  return {
    ...base,
    listFileNames: async (directory) => {
      await hooks.beforeList?.(directory);
      const names = await base.listFileNames(directory);
      return hooks.list === undefined ? names : hooks.list(directory, names);
    },
    listDirectoryNames: async (directory) => {
      const names = (await base.listDirectoryNames?.(directory)) ?? [];
      return hooks.directories === undefined ? names : hooks.directories(directory, names);
    },
    fileByteLength: async (path) => {
      await hooks.beforeLength?.(path);
      const length = await base.fileByteLength(path);
      await hooks.afterLength?.(path, length);
      return length;
    },
    writeWholeFile: async (path, bytes) => {
      await base.writeWholeFile(path, bytes);
      hooks.afterWholeFile?.(path);
    },
  };
}

describe("never below the disk, never past the cap", () => {
  it("a deletion during a rotation is given back once, and nothing more", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    let armed = false;
    let freed = 0;
    const fileSystem = hookedFileSystem(base, {
      // Expiry deletes the oldest sealed segment the moment the rotation's
      // manifest lands, between the footer and the next segment's header.
      afterWholeFile: (path) => {
        if (!armed || !path.endsWith(".wal.manifest.json")) return;
        const victim = oldestSealedPath(base, directoryOf(EPOCH_A), path);
        if (victim === undefined) return;
        armed = false;
        freed = base.peek(victim)?.length ?? 0;
        base.files.delete(victim);
        base.files.delete(victim.replace(/\.wal\.jsonl$/u, ".wal.manifest.json"));
      },
    });
    const writer = await openEpoch(fileSystem, clock, EPOCH_A);
    for (let index = 0; index < 10; index += 1) {
      writer.enqueue(frames.next(EPOCH_A));
      await writer.drain();
    }
    armed = true;
    for (let index = 0; index < 10 && armed; index += 1) {
      writer.enqueue(frames.next(EPOCH_A));
      await writer.drain();
      expectInvariants(writer, base);
    }
    expect(freed).toBeGreaterThan(0);
    const counted = writer.metrics().totalSegmentBytes;
    await writer.tick();
    expect(writer.metrics().capacityRelievedBytes).toBe(freed);
    expect(writer.metrics().totalSegmentBytes).toBe(counted - freed);
    await writer.tick();
    expect(writer.metrics().capacityRelievedBytes).toBe(freed);
    await fillToCap(writer, base, frames, EPOCH_A);
    await writer.close();
    expectInvariants(writer, base);
  });

  it("appends, a rotation and a deletion while a re-derivation is suspended mid-read", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    let hold: Promise<void> | undefined;
    let release: () => void = () => undefined;
    let paused: () => void = () => undefined;
    const reachedPause = new Promise<void>((resolve) => {
      paused = resolve;
    });
    const fileSystem = hookedFileSystem(base, {
      beforeLength: async () => {
        if (hold !== undefined) {
          paused();
          await hold;
        }
      },
    });
    const writer = await openEpoch(fileSystem, clock, EPOCH_A);
    for (let index = 0; index < 9; index += 1) {
      writer.enqueue(frames.next(EPOCH_A));
      await writer.drain();
    }
    // The re-derivation stops at its first length read: the open segment,
    // which is unsealed. Everything below happens while it waits.
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tick = writer.tick();
    await reachedPause;
    hold = undefined;
    for (let index = 0; index < 8; index += 1) {
      const result = writer.enqueue(frames.next(EPOCH_A));
      if (result.accepted) await writer.drain();
      expectInvariants(writer, base);
    }
    const [oldest] = await listSegmentManifests(base, directoryOf(EPOCH_A));
    const freed = expire(base, directoryOf(EPOCH_A), oldest as WalSegmentManifest);
    release();
    await tick;
    expectInvariants(writer, base);
    await writer.tick();
    expectInvariants(writer, base);
    expect(writer.metrics().capacityRelievedBytes).toBe(freed);
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));
    await fillToCap(writer, base, frames, EPOCH_A);
    await writer.close();
    expectInvariants(writer, base);
  });

  it("a stale listing keeps every counted segment; only a direct read that finds one gone lets it go", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const firstListing = new Map<string, readonly string[]>();
    let stale = false;
    const fileSystem = hookedFileSystem(base, {
      list: (directory, names) => {
        if (!firstListing.has(directory)) firstListing.set(directory, names);
        return stale ? (firstListing.get(directory) ?? []) : names;
      },
    });
    const first = await openEpoch(fileSystem, clock, EPOCH_A);
    for (let index = 0; index < 8; index += 1) {
      first.enqueue(frames.next(EPOCH_A));
      await first.drain();
    }
    await first.close();
    const second = await openEpoch(fileSystem, clock, EPOCH_B);
    // From now on every listing is the one taken at the second writer's open:
    // its own new segments, and later deletions, are invisible to listings.
    stale = true;
    for (let index = 0; index < 12; index += 1) {
      const result = second.enqueue(frames.next(EPOCH_B));
      if (result.accepted) await second.drain();
      await second.tick();
      expectInvariants(second, base);
    }
    const [oldest] = await listSegmentManifests(base, directoryOf(EPOCH_A));
    const freed = expire(base, directoryOf(EPOCH_A), oldest as WalSegmentManifest);
    await second.tick();
    expect(second.metrics().capacityRelievedBytes).toBe(freed);
    expect(second.metrics().totalSegmentBytes).toBe(onDisk(base));
    await second.close();
  });

  it("a partial listing drops nothing it does not see gone", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    let partial = false;
    const fileSystem = hookedFileSystem(base, {
      // Every other segment file is missing from the listing (its sidecar is
      // still listed), as a listing torn by a concurrent change could be.
      list: (_directory, names) => {
        if (!partial) return names;
        let segments = 0;
        return names.filter((name) => !name.endsWith(".wal.jsonl") || (segments++ % 2 === 0));
      },
    });
    const writer = await openEpoch(fileSystem, clock, EPOCH_A);
    await fillToCap(writer, base, frames, EPOCH_A);
    const counted = writer.metrics().totalSegmentBytes;
    partial = true;
    await writer.tick();
    await writer.tick();
    expect(writer.metrics().totalSegmentBytes).toBe(counted);
    expect(writer.metrics().capacityRelievedBytes).toBe(0);
    expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(false);
    await writer.close();
    expectInvariants(writer, base);
  });

  it("a failed re-derivation is counted, does not fault the writer, and keeps the count", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    let failures = 0;
    const events: WalCapacityRescanEvent[] = [];
    const fileSystem = hookedFileSystem(base, {
      beforeList: () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("EIO (injected)");
        }
      },
    });
    const writer = await openEpoch(fileSystem, clock, EPOCH_A, {
      observer: { onCapacityRescan: (event) => events.push(event) },
    });
    await fillToCap(writer, base, frames, EPOCH_A);
    const [oldest] = await listSegmentManifests(base, directoryOf(EPOCH_A));
    const freed = expire(base, directoryOf(EPOCH_A), oldest as WalSegmentManifest);
    const counted = writer.metrics().totalSegmentBytes;
    failures = 1;
    await writer.tick();
    expect(writer.state).toBe("open");
    expect(writer.metrics().capacityRescanFailures).toBe(1);
    expect(events.at(-1)?.outcome).toBe("failed");
    expect(writer.metrics().totalSegmentBytes).toBe(counted);
    expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(false);
    await writer.tick();
    expect(writer.metrics().capacityRelievedBytes).toBe(freed);
    expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(true);
    await writer.close();
    expectInvariants(writer, base);
  });

  it("never forgets the open segment, whose descriptor holds its bytes on disk", async () => {
    // Its name removed before the listing, and between the listing and the
    // length read: neither gives its bytes back.
    for (const when of ["before the listing", "after the listing"] as const) {
      const base = createMemoryFileSystem();
      const clock = createManualClock();
      const frames = feeder();
      const open: { path?: string } = {};
      const fileSystem = hookedFileSystem(base, {
        beforeLength: (path) => {
          if (when === "after the listing" && path === open.path) base.files.delete(path);
        },
      });
      const writer = await openEpoch(fileSystem, clock, EPOCH_A);
      writer.enqueue(frames.next(EPOCH_A));
      await writer.drain();
      expect(writer.activeSegmentId).not.toBeNull();
      open.path = `${directoryOf(EPOCH_A)}/${String(writer.activeSegmentId)}.wal.jsonl`;
      const counted = writer.metrics().totalSegmentBytes;
      if (when === "before the listing") base.files.delete(open.path);
      await writer.tick();
      expect(writer.metrics().totalSegmentBytes, when).toBe(counted);
      expect(writer.metrics().capacityRelievedBytes, when).toBe(0);
    }
  });

  it("a torn append's whole records still count after the fault, though the writer admits nothing more", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    let tearNext = false;
    const fileSystem: MemoryFileSystem = {
      ...base,
      openAppend: async (path) => {
        const handle = await base.openAppend(path);
        return {
          ...handle,
          append: async (bytes) => {
            if (!tearNext) return handle.append(bytes);
            tearNext = false;
            // Two and a half of the three records land, then the write fails.
            await handle.append(bytes.subarray(0, Math.floor((bytes.length * 5) / 6)));
            throw new Error("EIO (injected torn append)");
          },
        };
      },
    };
    const writer = await openEpoch(fileSystem, clock, EPOCH_A, { maxSegmentBytes: 100_000 });
    writer.enqueue(frames.next(EPOCH_A));
    await writer.drain();
    for (let index = 0; index < 3; index += 1) expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(true);
    tearNext = true;
    await expect(writer.drain()).rejects.toThrow();
    expect(writer.state).toBe("faulted");
    await writer.close();
    // The torn tail is truncated; the whole records it left are on disk.
    expect(writer.metrics().totalSegmentBytes).toBeGreaterThanOrEqual(onDisk(base));
    expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(false);
  });

  it("a length read that answers late, after more appends landed, does not lower the count", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    let hold: Promise<void> | undefined;
    let release: () => void = () => undefined;
    let answered: () => void = () => undefined;
    const lateAnswer = new Promise<void>((resolve) => {
      answered = resolve;
    });
    const fileSystem = hookedFileSystem(base, {
      afterLength: async () => {
        if (hold !== undefined) {
          const wait = hold;
          hold = undefined;
          answered();
          await wait;
        }
      },
    });
    const writer = await openEpoch(fileSystem, clock, EPOCH_A, { maxSegmentBytes: 100_000 });
    writer.enqueue(frames.next(EPOCH_A));
    await writer.drain();
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The re-derivation reads the open segment's length now, and answers
    // only after three more frames were appended to it.
    const tick = writer.tick();
    await lateAnswer;
    for (let index = 0; index < 3; index += 1) {
      writer.enqueue(frames.next(EPOCH_A));
      await writer.drain();
    }
    release();
    await tick;
    expect(writer.metrics().totalSegmentBytes).toBeGreaterThanOrEqual(onDisk(base));
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));
    await writer.close();
  });

  it("an unsealed segment deleted between the listing and its length read is given back in the same tick", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = feeder();
    const crashed = await openEpoch(base, clock, EPOCH_A);
    for (let index = 0; index < 2; index += 1) {
      crashed.enqueue(frames.next(EPOCH_A));
      await crashed.drain();
    }
    // Epoch A crashed: its open segment is unsealed. An operator removes it
    // while the next epoch's re-derivation is between the listing and the read.
    const unsealed = [...base.files.keys()].find((path) => path.startsWith(`${directoryOf(EPOCH_A)}/`)) as string;
    let armed = false;
    const fileSystem = hookedFileSystem(base, {
      beforeLength: (path) => {
        if (armed && path === unsealed) {
          armed = false;
          base.files.delete(path);
        }
      },
    });
    const next = await openEpoch(fileSystem, clock, EPOCH_B);
    const counted = next.metrics().totalSegmentBytes;
    expect(counted).toBe(onDisk(base));
    armed = true;
    await next.tick();
    expect(next.metrics().capacityRelievedBytes).toBe(counted);
    expect(next.metrics().totalSegmentBytes).toBe(0);
    await next.close();
  });

  it("holds both invariants over random sequences of appends, bursts, expiry and restarts", async () => {
    let seed = 0x5eed_c0de;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const epochs = [EPOCH_A, EPOCH_B, EPOCH_C];
    const seen = { refusals: 0, relievedBytes: 0, restarts: 0, crashes: 0, expiries: 0 };
    for (let run = 0; run < 60; run += 1) {
      const fileSystem = createMemoryFileSystem();
      const clock = createManualClock();
      let seq = 0;
      let epochIndex = 0;
      let writer = await openEpoch(fileSystem, clock, epochs[epochIndex] as string);
      for (let step = 0; step < 80; step += 1) {
        const roll = random();
        const epoch = epochs[epochIndex] as string;
        if (roll < 0.55) {
          // A burst, admitted before any drain: the queued-burst reservation.
          const burst = 1 + Math.floor(random() * 4);
          for (let index = 0; index < burst; index += 1) {
            seq += 1;
            const result = writer.enqueue(
              createTestFrame({ gatewayEpoch: epoch, ingestSeq: seq, payloadUtf8: "x".repeat(Math.floor(random() * 600)) }),
            );
            if (!result.accepted && result.reason === "capacity-exceeded") seen.refusals += 1;
          }
          await writer.drain();
        } else if (roll < 0.75) {
          await writer.tick();
        } else if (roll < 0.92) {
          // Expiry: any sealed segment of any epoch.
          const sealed: { directory: string; manifest: WalSegmentManifest }[] = [];
          for (const candidate of epochs) {
            for (const manifest of await listSegmentManifests(fileSystem, directoryOf(candidate))) {
              if (fileSystem.peek(`${directoryOf(candidate)}/${manifest.segmentFileName}`) !== undefined) {
                sealed.push({ directory: directoryOf(candidate), manifest });
              }
            }
          }
          const victim = sealed[Math.floor(random() * sealed.length)];
          if (victim !== undefined) {
            expire(fileSystem, victim.directory, victim.manifest);
            seen.expiries += 1;
          }
        } else if (epochIndex < epochs.length - 1) {
          // A restart into a new epoch: a clean close or a crash.
          if (random() < 0.5) await writer.close();
          else seen.crashes += 1;
          seen.restarts += 1;
          seen.relievedBytes += writer.metrics().capacityRelievedBytes;
          epochIndex += 1;
          writer = await openEpoch(fileSystem, clock, epochs[epochIndex] as string);
        }
        expectInvariants(writer, fileSystem);
      }
      seen.relievedBytes += writer.metrics().capacityRelievedBytes;
      if (writer.state === "open") await writer.close();
      expectInvariants(writer, fileSystem);
    }
    // Not vacuous: the sequences reached the cap, relieved it, and restarted.
    expect(seen.refusals).toBeGreaterThan(100);
    expect(seen.relievedBytes).toBeGreaterThan(0);
    expect(seen.expiries).toBeGreaterThan(100);
    expect(seen.restarts).toBeGreaterThan(20);
    expect(seen.crashes).toBeGreaterThan(5);
  });
});

describe("configuration", () => {
  it("refuses a capacity root on a filesystem that cannot list directories, rather than count less", async () => {
    const fileSystem: WalFileSystem = { ...createMemoryFileSystem() };
    delete (fileSystem as { listDirectoryNames?: unknown }).listDirectoryNames;
    expect(fileSystem.listDirectoryNames).toBeUndefined();
    await expect(openEpoch(fileSystem, createManualClock(), EPOCH_A)).rejects.toThrow(WalConfigurationError);
    // With no threshold there is nothing to count, so nothing to refuse.
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A, { maxTotalBytes: null });
    expect(writer.metrics().capacityBytes).toBeNull();
    await writer.close();
  });

  it("refuses an empty capacity root", async () => {
    await expect(
      openEpoch(createMemoryFileSystem(), createManualClock(), EPOCH_A, { capacityRootPath: "" }),
    ).rejects.toThrow(WalConfigurationError);
  });

  it("a writer with no threshold reads no listing on tick", async () => {
    const base = createMemoryFileSystem();
    let listings = 0;
    const fileSystem = hookedFileSystem(base, {
      beforeList: () => {
        listings += 1;
      },
    });
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A, { maxTotalBytes: null });
    const atOpen = listings;
    await writer.tick();
    await writer.tick();
    expect(listings).toBe(atOpen);
    expect(writer.metrics().capacityRescans).toBe(0);
    expect(writer.metrics().capacityReached).toBe(false);
    await writer.close();
  });
});
