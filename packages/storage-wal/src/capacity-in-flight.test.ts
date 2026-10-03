/**
 * `WALCAP-1` rounds 1 and 2: the gaps the joint reviews found in
 * `maxTotalBytes`.
 *
 * - **A-01, frames in flight.** `drain()` takes the queue with `takeAll()` and
 *   then awaits the filesystem. The gateway keeps enqueueing while it waits,
 *   and the frames the drain took were then neither queued nor in the
 *   ledger: admission did not charge them, nor their framing, so a cap of
 *   6,000 bytes ended at 8,010. Every test here suspends a REAL filesystem
 *   call of a drain — a segment's creation, its header, an append before and
 *   after its bytes land, a rotation's footer and sidecar, an fsync — and
 *   offers frames until the cap refuses one.
 * - **O-L1, a failed write.** Bytes a failed write left on disk (a header
 *   whose fsync failed, a torn append, a footer whose sidecar failed) are
 *   counted before the writer faults, not only at its `close()`, or never.
 * - **O-M1, the count at open fails closed.** A restart that cannot read the
 *   WAL root does not open: a count it could not read bounds nothing.
 * - **O-I4.** Two ticks at once re-derive the count once.
 * - **TR (round 2), a time rotation.** A segment closed by age with frames
 *   still unwritten sent them to a new segment whose framing nobody had
 *   reserved: a 6,000-byte cap ended at 6,359 bytes, after `close()` too.
 * - **N-1 (round 2).** A failed write's fallback counts, and that the count is
 *   taken before the fault is raised.
 * - **N-2 (round 2).** The in-flight frames that landed are not reserved for
 *   again.
 *
 * The invariants checked: the segment bytes on disk under the root never pass
 * `maxTotalBytes`, at any instant; once no write is in flight the writer's
 * count is never below them; and what admission charges beyond the ledger is
 * exactly the accepted frames not yet written.
 */

import { describe, expect, it } from "vitest";

import { listSegmentManifests, manifestFileName } from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import type { RawFrameRecord } from "./raw-frame.js";
import { encodeFrameLine } from "./segment-format.js";
import type { WalFileSystem } from "./ports.js";
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

function directoryOf(epoch: string): string {
  return `${ROOT}/${epoch}`;
}

/** Segment bytes on disk under the root: the quantity `maxTotalBytes` bounds. */
function onDisk(fileSystem: MemoryFileSystem): number {
  let total = 0;
  for (const [path, bytes] of fileSystem.files) {
    if (path.startsWith(`${ROOT}/`) && path.endsWith(".wal.jsonl")) total += bytes.length;
  }
  return total;
}

function expectInvariants(writer: WalWriter, fileSystem: MemoryFileSystem, cap = CAP): void {
  const disk = onDisk(fileSystem);
  expect(disk, "segment bytes on disk under the root").toBeLessThanOrEqual(cap);
  expect(writer.metrics().totalSegmentBytes, "the writer's count against the disk").toBeGreaterThanOrEqual(disk);
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
    // No time rotation here: the r2 tests below hold the cap against it
    // (TR).
    maxSegmentAgeMs: 1_000_000_000,
    ...overrides,
  });
}

/** Frames with consecutive sequence numbers; remembers the line bytes of every frame it made. */
class Frames {
  #seq = 0;
  readonly lineBytes = new Map<string, number>();

  next(epoch: string, payloadUtf8?: string): RawFrameRecord {
    this.#seq += 1;
    const frame = createTestFrame({
      gatewayEpoch: epoch,
      ingestSeq: this.#seq,
      payloadUtf8: payloadUtf8 ?? `{"n":${String(this.#seq)}}`,
    });
    this.lineBytes.set(frame.ingestSeq, encodeFrameLine(frame).length);
    return frame;
  }
}

/** `ingestSeq`s of every whole frame line on disk under the root. */
function framesOnDisk(fileSystem: MemoryFileSystem): Set<string> {
  const seen = new Set<string>();
  for (const [path, bytes] of fileSystem.files) {
    if (!path.startsWith(`${ROOT}/`) || !path.endsWith(".wal.jsonl")) continue;
    const text = bytes.toString("utf8");
    const whole = text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of whole.split("\n")) {
      if (line === "") continue;
      const parsed = JSON.parse(line) as { record?: string; ingestSeq?: string };
      if (parsed.record === undefined && parsed.ingestSeq !== undefined) seen.add(parsed.ingestSeq);
    }
  }
  return seen;
}

/** Line bytes of the accepted frames that are not on disk yet. */
function unwrittenBytes(fileSystem: MemoryFileSystem, frames: Frames, accepted: readonly string[]): number {
  const written = framesOnDisk(fileSystem);
  let total = 0;
  for (const seq of accepted) {
    if (!written.has(seq)) total += frames.lineBytes.get(seq) ?? Number.NaN;
  }
  return total;
}

/**
 * What admission charges beyond the ledger and the framing reservation: the
 * accepted frames the ledger does not hold yet. Read back from the metrics,
 * so only meaningful while the cap still has room.
 */
function chargedUnwritten(writer: WalWriter, cap = CAP): number {
  const metrics = writer.metrics();
  const remaining = metrics.capacityRemainingBytes ?? 0;
  expect(remaining, "the charge is readable only below the cap").toBeGreaterThan(0);
  return cap - remaining - (metrics.capacityReservedBytes ?? 0) - metrics.totalSegmentBytes;
}

/** What raw-WAL expiry does to a sealed segment: the segment, then its sidecar. */
function expire(fileSystem: MemoryFileSystem, directory: string, manifest: WalSegmentManifest): number {
  const segmentPath = `${directory}/${manifest.segmentFileName}`;
  const bytes = fileSystem.peek(segmentPath)?.length ?? 0;
  fileSystem.files.delete(segmentPath);
  fileSystem.files.delete(`${directory}/${manifestFileName(manifest.segmentId)}`);
  return bytes;
}

type Line = "header" | "frames" | "footer";

/** A filesystem call a gate can hold. */
type GatedCall =
  | { readonly op: "openAppend"; readonly path: string }
  | { readonly op: "append"; readonly path: string; readonly line: Line }
  | { readonly op: "sync"; readonly path: string }
  | { readonly op: "writeWholeFile"; readonly path: string };

type When = "before" | "after";

type Gate = {
  /** Resolves when the held call is reached. */
  readonly reached: Promise<void>;
  release(): void;
};

function lineOf(bytes: Uint8Array): Line {
  const head = Buffer.from(bytes.subarray(0, 20)).toString("utf8");
  if (head.startsWith('{"record":"header"')) return "header";
  if (head.startsWith('{"record":"footer"')) return "footer";
  return "frames";
}

/**
 * A memory filesystem that can hold one call, before it runs or after it
 * returned, until the test releases it: a drain suspended in a real write.
 */
function gatedFileSystem(base: MemoryFileSystem): {
  readonly fileSystem: MemoryFileSystem;
  hold(match: (call: GatedCall) => boolean, when: When): Gate;
  disarm(): void;
} {
  let armed:
    | { match: (call: GatedCall) => boolean; when: When; reached: () => void; wait: Promise<void> }
    | undefined;
  const pass = async (call: GatedCall, when: When): Promise<void> => {
    const gate = armed;
    if (gate === undefined || gate.when !== when || !gate.match(call)) return;
    armed = undefined;
    gate.reached();
    await gate.wait;
  };
  const around = async <T>(call: GatedCall, operation: () => Promise<T>): Promise<T> => {
    await pass(call, "before");
    const result = await operation();
    await pass(call, "after");
    return result;
  };
  const fileSystem: MemoryFileSystem = {
    ...base,
    openAppend: async (path) => {
      const handle = await around({ op: "openAppend", path }, async () => base.openAppend(path));
      return {
        append: async (bytes) => around({ op: "append", path, line: lineOf(bytes) }, async () => handle.append(bytes)),
        sync: async () => around({ op: "sync", path }, async () => handle.sync()),
        close: async () => handle.close(),
      };
    },
    writeWholeFile: async (path, bytes) =>
      around({ op: "writeWholeFile", path }, async () => base.writeWholeFile(path, bytes)),
  };
  return {
    fileSystem,
    hold(match, when) {
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reachedPromise = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      armed = { match, when, reached, wait };
      return { reached: reachedPromise, release };
    },
    disarm() {
      armed = undefined;
    },
  };
}

/** Resolves `true` when the gate is reached, `false` when the drain ends first. */
async function suspended(gate: Gate, drain: Promise<unknown>): Promise<boolean> {
  return Promise.race([gate.reached.then(() => true), drain.then(() => false)]);
}

/** Offer frames until the cap refuses one; returns the sequence numbers admitted. */
function offerUntilRefused(writer: WalWriter, frames: Frames, epoch: string, limit = 200): string[] {
  const admitted: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const frame = frames.next(epoch);
    const result = writer.enqueue(frame);
    if (!result.accepted) {
      expect(result.reason).toBe("capacity-exceeded");
      return admitted;
    }
    admitted.push(frame.ingestSeq);
  }
  throw new Error(`the cap never refused within ${String(limit)} frames`);
}

describe("frames a drain has taken and not yet recorded count against the cap (A-01)", () => {
  type Case = {
    readonly name: string;
    /** Frames written (one drain each) before the drain under test, so it starts mid-segment. */
    readonly prefill: number;
    readonly match: (call: GatedCall) => boolean;
    readonly when: When;
    /** A frame write is mid-flight at the gate: its bytes may be on disk and still charged. */
    readonly frameWriteInFlight?: boolean;
    readonly overrides?: Partial<WalWriterOptions>;
  };
  const cases: readonly Case[] = [
    { name: "a segment's creation, before the file exists", prefill: 0, match: (call) => call.op === "openAppend", when: "before" },
    { name: "a segment's header, on disk and not yet counted", prefill: 0, match: (call) => call.op === "append" && call.line === "header", when: "after" },
    { name: "the header's fsync", prefill: 0, match: (call) => call.op === "sync", when: "before" },
    { name: "a frame append, before its bytes land", prefill: 1, match: (call) => call.op === "append" && call.line === "frames", when: "before" },
    {
      name: "a frame append, its bytes on disk and not yet counted",
      prefill: 1,
      match: (call) => call.op === "append" && call.line === "frames",
      when: "after",
      frameWriteInFlight: true,
    },
    { name: "a rotation's footer, on disk", prefill: 3, match: (call) => call.op === "append" && call.line === "footer", when: "after" },
    {
      name: "a rotation's sidecar manifest, written",
      prefill: 3,
      match: (call) => call.op === "writeWholeFile" && call.path.endsWith(".wal.manifest.json"),
      when: "after",
    },
    {
      name: "an fsync at the byte threshold, after a batch landed and was counted",
      prefill: 1,
      match: (call) => call.op === "sync",
      when: "before",
      overrides: { fsyncByteThreshold: 1 },
    },
  ];

  for (const testCase of cases) {
    it(`held in ${testCase.name}: never past the cap, and the charge is exact`, async () => {
      const base = createMemoryFileSystem();
      const gated = gatedFileSystem(base);
      const clock = createManualClock();
      const frames = new Frames();
      const accepted: string[] = [];
      const writer = await openEpoch(gated.fileSystem, clock, EPOCH_A, testCase.overrides ?? {});
      for (let index = 0; index < testCase.prefill; index += 1) {
        const frame = frames.next(EPOCH_A);
        expect(writer.enqueue(frame).accepted).toBe(true);
        accepted.push(frame.ingestSeq);
        await writer.drain();
      }
      // A burst the drain takes whole: most of what it will write is in flight.
      for (let index = 0; index < 12; index += 1) {
        const frame = frames.next(EPOCH_A);
        expect(writer.enqueue(frame).accepted).toBe(true);
        accepted.push(frame.ingestSeq);
      }
      const gate = gated.hold(testCase.match, testCase.when);
      const drain = writer.drain();
      expect(await suspended(gate, drain), "the drain reached the held call").toBe(true);
      expect(writer.metrics().queue.currentDepth, "the drain took the whole burst").toBe(0);

      // Read before anything new is offered, asserted at the end: what
      // admission charges beyond the ledger, and the accepted frames that are
      // not on disk yet.
      const unwritten = unwrittenBytes(base, frames, accepted);
      const charged = chargedUnwritten(writer);

      // The gateway keeps enqueueing while the drain waits on the disk.
      const during = offerUntilRefused(writer, frames, EPOCH_A);
      expect(during.length, "the cap still had room during the suspension").toBeGreaterThan(0);
      accepted.push(...during);
      expect(onDisk(base)).toBeLessThanOrEqual(CAP);

      gate.release();
      await drain;
      await writer.drain();
      expectInvariants(writer, base);
      expect(framesOnDisk(base).size, "every admitted frame was written").toBe(accepted.length);
      expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));
      await writer.close();
      expectInvariants(writer, base);
      expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));

      // At the gate, admission charged exactly the accepted frames not yet
      // on disk — or, with a frame write mid-flight, those plus the bytes it
      // had landed and the ledger had not counted yet.
      expect(unwritten).toBeGreaterThan(0);
      if (testCase.frameWriteInFlight === true) {
        expect(charged, "the landed batch is still charged").toBeGreaterThan(unwritten);
      } else {
        expect(charged, "charged beyond the ledger at the gate").toBe(unwritten);
      }
    });
  }

  it("a fault mid-drain hands the in-flight frames back and stops charging them", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = new Frames();
    let failNext = false;
    const fileSystem: MemoryFileSystem = {
      ...base,
      openAppend: async (path) => {
        const handle = await base.openAppend(path);
        return {
          ...handle,
          append: async (bytes) => {
            if (failNext && lineOf(bytes) === "frames") {
              failNext = false;
              throw new Error("EIO (injected)");
            }
            await handle.append(bytes);
          },
        };
      },
    };
    const writer = await openEpoch(fileSystem, clock, EPOCH_A, { maxSegmentBytes: 100_000 });
    writer.enqueue(frames.next(EPOCH_A));
    await writer.drain();
    for (let index = 0; index < 6; index += 1) writer.enqueue(frames.next(EPOCH_A));
    failNext = true;
    await expect(writer.drain()).rejects.toThrow();
    expect(writer.state).toBe("faulted");
    expect(writer.pendingFrames()).toHaveLength(7);
    // Nothing of them is charged any more: this writer will never write them.
    expect(chargedUnwritten(writer)).toBe(0);
    await writer.close();
    expectInvariants(writer, base);
  });

  it("holds the cap over random drains suspended anywhere, with expiry and restarts in between", async () => {
    let seed = 0x0a01_cafe;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pick = <T>(values: readonly T[]): T | undefined => values[Math.floor(random() * values.length)];
    const pickOne = <T>(values: readonly T[]): T => {
      const value = pick(values);
      if (value === undefined) throw new Error("nothing to pick from");
      return value;
    };
    const epochs = [EPOCH_A, EPOCH_B, EPOCH_C];
    const matchers: readonly ((call: GatedCall) => boolean)[] = [
      (call) => call.op === "openAppend",
      (call) => call.op === "append" && call.line === "header",
      (call) => call.op === "append" && call.line === "frames",
      (call) => call.op === "append" && call.line === "footer",
      (call) => call.op === "sync",
      (call) => call.op === "writeWholeFile",
    ];
    const seen = { suspensions: 0, admittedWhileSuspended: 0, refusedWhileSuspended: 0, expiriesWhileSuspended: 0, restarts: 0 };

    const sealedSegments = async (fileSystem: MemoryFileSystem) => {
      const sealed: { directory: string; manifest: WalSegmentManifest }[] = [];
      for (const candidate of epochs) {
        for (const manifest of await listSegmentManifests(fileSystem, directoryOf(candidate))) {
          if (fileSystem.peek(`${directoryOf(candidate)}/${manifest.segmentFileName}`) !== undefined) {
            sealed.push({ directory: directoryOf(candidate), manifest });
          }
        }
      }
      return sealed;
    };

    for (let run = 0; run < 60; run += 1) {
      const base = createMemoryFileSystem();
      const gated = gatedFileSystem(base);
      const clock = createManualClock();
      const frames = new Frames();
      let epochIndex = 0;
      const segmentBytes = pickOne([900, 1_500, 2_000, 3_000]);
      const open = async (epoch: string) => openEpoch(gated.fileSystem, clock, epoch, { maxSegmentBytes: segmentBytes });
      let writer = await open(EPOCH_A);
      for (let step = 0; step < 50; step += 1) {
        const roll = random();
        const epoch = epochs[epochIndex] as string;
        if (roll < 0.6) {
          const burst = 1 + Math.floor(random() * 12);
          for (let index = 0; index < burst; index += 1) {
            writer.enqueue(frames.next(epoch, "x".repeat(Math.floor(random() * 500))));
          }
          const gate = gated.hold(pickOne(matchers), random() < 0.5 ? "before" : "after");
          const drain = writer.drain();
          if (await suspended(gate, drain)) {
            seen.suspensions += 1;
            const offers = Math.floor(random() * 16);
            for (let index = 0; index < offers; index += 1) {
              const result = writer.enqueue(frames.next(epoch, "y".repeat(Math.floor(random() * 500))));
              if (result.accepted) seen.admittedWhileSuspended += 1;
              else if (result.reason === "capacity-exceeded") seen.refusedWhileSuspended += 1;
            }
            if (random() < 0.5) {
              const victim = pick(await sealedSegments(base));
              if (victim !== undefined) {
                expire(base, victim.directory, victim.manifest);
                seen.expiriesWhileSuspended += 1;
              }
            }
            expect(onDisk(base), "mid-drain").toBeLessThanOrEqual(CAP);
            gate.release();
          } else {
            gated.disarm();
          }
          await drain;
          await writer.drain();
        } else if (roll < 0.72) {
          await writer.tick();
        } else if (roll < 0.92) {
          const victim = pick(await sealedSegments(base));
          if (victim !== undefined) expire(base, victim.directory, victim.manifest);
        } else if (epochIndex < epochs.length - 1) {
          // A clean close, or a crash (whose unsealed segment expiry never frees).
          if (random() < 0.7) await writer.close();
          seen.restarts += 1;
          epochIndex += 1;
          writer = await open(epochs[epochIndex] as string);
        }
        expectInvariants(writer, base);
      }
      if (writer.state === "open") await writer.close();
      expectInvariants(writer, base);
    }
    // Not vacuous: drains were held in every kind of call, frames were
    // admitted and refused while they were, and expiry ran meanwhile.
    expect(seen.suspensions).toBeGreaterThan(250);
    expect(seen.admittedWhileSuspended).toBeGreaterThan(250);
    expect(seen.refusedWhileSuspended).toBeGreaterThan(500);
    expect(seen.expiriesWhileSuspended).toBeGreaterThan(100);
    expect(seen.restarts).toBeGreaterThan(60);
  });
});

describe("what a failed write left on disk is counted before the writer faults (O-L1)", () => {
  /** A memory filesystem whose next planned call fails, after (or instead of) running. */
  function failing(base: MemoryFileSystem) {
    const plan: {
      /** The next header fsync fails; the header is already on disk. */
      headerSync?: true;
      /** The next frame append lands what this returns, then fails. */
      append?: (bytes: Uint8Array) => Uint8Array | null;
      /** The next sidecar manifest write fails. */
      manifest?: true;
      /** This many length reads answer, then one fails. */
      lengthReadsBeforeFailure?: number;
    } = {};
    const headerSynced = new Set<string>();
    const fileSystem: MemoryFileSystem = {
      ...base,
      openAppend: async (path) => {
        const handle = await base.openAppend(path);
        return {
          append: async (bytes) => {
            const tear = plan.append;
            if (tear !== undefined && lineOf(bytes) === "frames") {
              delete plan.append;
              const landed = tear(bytes);
              if (landed !== null) await handle.append(landed);
              throw new Error("EIO (injected append)");
            }
            await handle.append(bytes);
          },
          sync: async () => {
            if (plan.headerSync === true && !headerSynced.has(path)) {
              delete plan.headerSync;
              throw new Error("ENOSPC (injected fsync)");
            }
            headerSynced.add(path);
            await handle.sync();
          },
          close: async () => handle.close(),
        };
      },
      writeWholeFile: async (path, bytes) => {
        if (plan.manifest === true && path.endsWith(".wal.manifest.json")) {
          delete plan.manifest;
          throw new Error("ENOSPC (injected sidecar)");
        }
        await base.writeWholeFile(path, bytes);
      },
      fileByteLength: async (path) => {
        if (plan.lengthReadsBeforeFailure !== undefined) {
          if (plan.lengthReadsBeforeFailure === 0) {
            delete plan.lengthReadsBeforeFailure;
            throw new Error("EIO (injected length read)");
          }
          plan.lengthReadsBeforeFailure -= 1;
        }
        return base.fileByteLength(path);
      },
    };
    return { fileSystem, plan };
  }

  it("a segment whose header landed and whose creation then failed", async () => {
    const base = createMemoryFileSystem();
    const { fileSystem, plan } = failing(base);
    const frames = new Frames();
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A);
    plan.headerSync = true;
    writer.enqueue(frames.next(EPOCH_A));
    await expect(writer.drain()).rejects.toThrow();
    expect(writer.state).toBe("faulted");
    expect(onDisk(base)).toBeGreaterThan(0);
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));
    await writer.close();
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));
  });

  it("the same, when the length read fails too: the whole header is counted", async () => {
    const base = createMemoryFileSystem();
    const { fileSystem, plan } = failing(base);
    const frames = new Frames();
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A);
    plan.headerSync = true;
    // The creation's pre-check (is the name free?) answers; the read on the
    // fault path is the one that fails.
    plan.lengthReadsBeforeFailure = 1;
    writer.enqueue(frames.next(EPOCH_A));
    await expect(writer.drain()).rejects.toThrow();
    expect(plan.lengthReadsBeforeFailure, "the fault path's read was the one that failed").toBeUndefined();
    const segments = [...base.files.entries()].filter(([path]) => path.endsWith(".wal.jsonl"));
    expect(segments).toHaveLength(1);
    const [, header] = segments[0] as [string, Buffer];
    expect(header.toString("utf8")).toMatch(/^\{"record":"header"[^\n]*\n$/u);
    // Exactly what the failed write could have left: its header line.
    expect(writer.metrics().totalSegmentBytes).toBe(header.length);
  });

  it("a torn append's landed prefix, the moment the writer faults, before any close", async () => {
    const base = createMemoryFileSystem();
    const { fileSystem, plan } = failing(base);
    const frames = new Frames();
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A, { maxSegmentBytes: 100_000 });
    writer.enqueue(frames.next(EPOCH_A));
    await writer.drain();
    for (let index = 0; index < 3; index += 1) writer.enqueue(frames.next(EPOCH_A));
    // Two and a half of the three records land, then the write fails.
    plan.append = (bytes) => bytes.subarray(0, Math.floor((bytes.length * 5) / 6));
    await expect(writer.drain()).rejects.toThrow();
    expect(writer.state).toBe("faulted");
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));
    expect(chargedUnwritten(writer)).toBe(0);
    await writer.close();
    expect(writer.metrics().totalSegmentBytes).toBeGreaterThanOrEqual(onDisk(base));
  });

  it("a rotation whose footer landed and whose sidecar failed", async () => {
    const base = createMemoryFileSystem();
    const { fileSystem, plan } = failing(base);
    const frames = new Frames();
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A);
    writer.enqueue(frames.next(EPOCH_A));
    await writer.drain();
    plan.manifest = true;
    await expect(writer.rotate()).rejects.toThrow();
    expect(writer.state).toBe("faulted");
    const segment = [...base.files.values()][0]?.toString("utf8") ?? "";
    expect(segment).toContain('{"record":"footer"');
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));
    await writer.close();
    expect(writer.metrics().totalSegmentBytes).toBeGreaterThanOrEqual(onDisk(base));
  });
});

describe("the count at open fails closed (O-M1)", () => {
  type Failing = "the root listing" | "an earlier epoch's listing" | "an earlier epoch's segment length";
  const failures: readonly Failing[] = ["the root listing", "an earlier epoch's listing", "an earlier epoch's segment length"];

  for (const failure of failures) {
    it(`a restart whose read of ${failure} fails does not open, and writes nothing`, async () => {
      const base = createMemoryFileSystem();
      const clock = createManualClock();
      const frames = new Frames();
      const first = await openEpoch(base, clock, EPOCH_A);
      for (let index = 0; index < 200; index += 1) {
        if (!first.enqueue(frames.next(EPOCH_A)).accepted) break;
        await first.drain();
      }
      await first.close();
      const before = base.snapshot();
      expect(onDisk(base)).toBeGreaterThan(CAP - 1_000);

      let armed = true;
      const fail = (): never => {
        armed = false;
        throw new Error(`EIO (injected: ${failure})`);
      };
      const fileSystem: MemoryFileSystem = {
        ...base,
        listDirectoryNames: async (directory) => {
          if (armed && failure === "the root listing" && directory === ROOT) fail();
          return (await base.listDirectoryNames?.(directory)) ?? [];
        },
        listFileNames: async (directory) => {
          if (armed && failure === "an earlier epoch's listing" && directory === directoryOf(EPOCH_A)) fail();
          return base.listFileNames(directory);
        },
        fileByteLength: async (path) => {
          if (armed && failure === "an earlier epoch's segment length" && path.startsWith(`${directoryOf(EPOCH_A)}/`)) fail();
          return base.fileByteLength(path);
        },
      };
      await expect(openEpoch(fileSystem, clock, EPOCH_B)).rejects.toThrow(/EIO \(injected/u);
      expect(armed, "the injected read was reached").toBe(false);
      expect(base.snapshot()).toStrictEqual(before);

      // Once the disk answers, the restart counts the earlier epoch and is
      // refused at the cap.
      const second = await openEpoch(fileSystem, clock, EPOCH_B);
      expect(second.metrics().totalSegmentBytes).toBe(onDisk(base));
      expect(second.enqueue(frames.next(EPOCH_B)).accepted).toBe(false);
      await second.close();
      expectInvariants(second, base);
    });
  }
});

describe("re-derivations never overlap (O-I4)", () => {
  it("two ticks at once re-derive the count once, never two reads in parallel", async () => {
    const base = createMemoryFileSystem();
    let inFlight = 0;
    let most = 0;
    const observe = async <T>(operation: () => Promise<T>): Promise<T> => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      try {
        await Promise.resolve();
        return await operation();
      } finally {
        inFlight -= 1;
      }
    };
    const fileSystem: MemoryFileSystem = {
      ...base,
      listFileNames: async (directory) => observe(async () => base.listFileNames(directory)),
      listDirectoryNames: async (directory) => observe(async () => (await base.listDirectoryNames?.(directory)) ?? []),
      fileByteLength: async (path) => observe(async () => base.fileByteLength(path)),
    };
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A);
    most = 0;
    await Promise.all([writer.tick(), writer.tick()]);
    expect(writer.metrics().capacityRescans).toBe(1);
    expect(most).toBe(1);
    await writer.tick();
    expect(writer.metrics().capacityRescans).toBe(2);
    await writer.close();
  });
});

/**
 * `WALCAP-1` round 2, finding TR: a time rotation added framing nobody had
 * reserved. The packing reserved a backlog's framing by the size rule alone;
 * a segment that was aged, or aged before the backlog was written, was then
 * closed by time and the backlog started a new segment, so a 6,000-byte cap
 * ended at 6,359 bytes and stayed there after `close()`. Two guards now hold
 * the cap:
 *
 * - admission also packs the backlog as if the open segment were closed
 *   first, whenever it holds a record, and reserves the larger framing. The
 *   time rotation then happens on time;
 * - a time rotation, in `drain()` or `tick()`, that admission could not
 *   foresee (a segment this backlog opened, aged before the backlog is
 *   written) waits until it fits. The frames go where admission put them.
 */
describe("a time rotation never takes the disk past the cap (r2, TR)", () => {
  const AGE_MS = 1_000;

  async function openTimed(
    fileSystem: WalFileSystem,
    clock: ManualClock,
    cap: number,
    options: { readonly root?: boolean; readonly overrides?: Partial<WalWriterOptions> } = {},
  ): Promise<WalWriter> {
    return openWalWriter({
      directoryPath: directoryOf(EPOCH_A),
      gatewayEpoch: EPOCH_A,
      fileSystem,
      clock,
      maxTotalBytes: cap,
      ...(options.root === false ? {} : { capacityRootPath: ROOT }),
      // Segments only time closes: the case §11.1 used to except.
      maxSegmentBytes: 64_000_000,
      maxSegmentAgeMs: AGE_MS,
      ...options.overrides,
    });
  }

  /** `[closeReason, recordCount]` of every manifest of an epoch, in segment order. */
  async function closes(fileSystem: MemoryFileSystem, epoch = EPOCH_A): Promise<[string, number][]> {
    return (await listSegmentManifests(fileSystem, directoryOf(epoch))).map((manifest) => [
      manifest.closeReason,
      manifest.recordCount,
    ]);
  }

  for (const cap of [3_000, 6_000, 20_000]) {
    for (const root of [true, false]) {
      for (const aged of ["before the burst", "between the burst and its drain"] as const) {
        it(`a ${String(cap)}-byte cap${root ? " over the root" : ", own directory"}, the segment aged ${aged}: a burst to refusal stays under it, and the rotation is on time`, async () => {
          const base = createMemoryFileSystem();
          const clock = createManualClock();
          const frames = new Frames();
          const writer = await openTimed(base, clock, cap, { root });
          expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(true);
          await writer.drain();

          if (aged === "before the burst") clock.advance(AGE_MS);
          const burst = offerUntilRefused(writer, frames, EPOCH_A);
          expect(burst.length, "the cap had room for a burst").toBeGreaterThan(0);
          if (aged === "between the burst and its drain") clock.advance(AGE_MS);
          await writer.drain();
          expectInvariants(writer, base, cap);
          await writer.close();
          // Before r2: 3,210, 6,359 and 20,185 bytes, after close.
          expectInvariants(writer, base, cap);

          expect(framesOnDisk(base).size, "every admitted frame was written").toBe(1 + burst.length);
          // On time: the aged segment was closed by age before the burst, whose
          // new segment's framing admission had reserved.
          expect(await closes(base)).toEqual([
            ["time-rotation", 1],
            ["shutdown", burst.length],
          ]);
          expect(writer.metrics().timeRotationsDeferred).toBe(0);
        });
      }
    }
  }

  it("a segment the backlog opened, aged before the rest of it is written: the time rotation waits, and closes the segment once nothing is unwritten", async () => {
    const base = createMemoryFileSystem();
    const gated = gatedFileSystem(base);
    const clock = createManualClock();
    const frames = new Frames();
    const cap = 6_000;
    const writer = await openTimed(gated.fileSystem, clock, cap);
    const accepted: string[] = [];
    const first = frames.next(EPOCH_A);
    expect(writer.enqueue(first).accepted).toBe(true);
    accepted.push(first.ingestSeq);

    // The drain opens a segment and is held before its first record lands:
    // no rotation can close a segment that holds no record, so the frames
    // admitted now reserve no new segment.
    const gate = gated.hold((call) => call.op === "append" && call.line === "frames", "before");
    const drain = writer.drain();
    expect(await suspended(gate, drain), "the drain reached the held call").toBe(true);
    expect(writer.metrics().activeSegmentRecordCount).toBe(0);
    accepted.push(...offerUntilRefused(writer, frames, EPOCH_A));
    expect(accepted.length).toBeGreaterThan(2);

    // The segment ages before the rest is written.
    clock.advance(AGE_MS);
    gate.release();
    await drain;
    expectInvariants(writer, base, cap);
    expect(framesOnDisk(base).size, "every admitted frame was written").toBe(accepted.length);
    const afterDrain = { ...writer.metrics() };
    // Nothing is unwritten now: closing costs only the reserved footer.
    await writer.tick();
    const afterTick = await closes(base);
    await writer.close();
    // Before r2 the drain closed the segment by time and opened another one
    // for the rest: 6,359 bytes against 6,000 once that one closed.
    expectInvariants(writer, base, cap);

    expect(afterDrain.segmentsFinalized, "the rotation waited: still open, and aged").toBe(0);
    expect(afterDrain.timeRotationsDeferred).toBe(1);
    expect(afterTick, "closed by age once nothing was unwritten").toEqual([["time-rotation", accepted.length]]);
    expect(writer.metrics().timeRotationsDeferred).toBe(1);
  });

  for (const fits of [false, true]) {
    it(
      fits
        ? "a tick whose rotation lands exactly on the cap goes ahead"
        : "a tick that finds the segment aged with frames queued waits too, once the count grew under them, and still fsyncs",
      async () => {
        const base = createMemoryFileSystem();
        const clock = createManualClock();
        const frames = new Frames();
        const cap = 6_000;
        const writer = await openTimed(base, clock, cap, { overrides: { fsyncIntervalMs: 100 } });
        expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(true);
        await writer.drain();
        // Nothing unwritten: the reservation is the open segment's footer alone.
        const footer = writer.metrics().capacityReservedBytes ?? Number.NaN;
        for (let index = 0; index < 2; index += 1) expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(true);
        // Admitted with the new segment a time rotation would open reserved.
        const queued = writer.metrics();
        const newSegment = (queued.capacityReservedBytes ?? Number.NaN) - footer;
        expect(newSegment).toBeGreaterThan(0);
        const remaining = queued.capacityRemainingBytes ?? Number.NaN;

        // A segment file another writer put under the root (one writer per
        // root is a premise; the count sees it anyway). Waiting: it takes
        // more than the room left, though less than the reservation, so the
        // queued frames still fit in the open segment and a new one for them
        // would not. Exactly on the cap: it takes the room left, no more.
        const foreign = fits ? remaining : remaining + Math.floor(newSegment / 2);
        base.files.set(`${directoryOf(EPOCH_B)}/${EPOCH_B}-000000.wal.jsonl`, Buffer.alloc(foreign, 0x61));
        await writer.tick();
        expect(writer.metrics().totalSegmentBytes, "the re-derivation counts it").toBe(onDisk(base));

        clock.advance(AGE_MS);
        const fsyncs = writer.metrics().fsyncCount;
        await writer.tick();
        if (fits) {
          expect(await closes(base)).toEqual([["time-rotation", 1]]);
          await writer.close();
          expect(await closes(base)).toEqual([
            ["time-rotation", 1],
            ["shutdown", 2],
          ]);
          expect(writer.metrics().timeRotationsDeferred).toBe(0);
          expectInvariants(writer, base, cap);
          return;
        }
        expect(writer.metrics().timeRotationsDeferred).toBe(1);
        expect(writer.metrics().segmentsFinalized, "the rotation waited").toBe(0);
        expect(writer.metrics().fsyncCount, "the data-loss bound did not wait for it").toBe(fsyncs + 1);

        // The drain's own check waits as well: the frames go into the aged segment.
        await writer.drain();
        expect(writer.metrics().segmentsFinalized).toBe(0);
        expectInvariants(writer, base, cap);
        await writer.tick();
        expect(await closes(base)).toEqual([["time-rotation", 3]]);
        await writer.close();
        expectInvariants(writer, base, cap);
      },
    );
  }

  it("a segment with nothing unwritten is closed by age even when foreign bytes put the count past the cap: closing adds only its reserved footer", async () => {
    const base = createMemoryFileSystem();
    const clock = createManualClock();
    const frames = new Frames();
    const cap = 6_000;
    const writer = await openTimed(base, clock, cap);
    expect(writer.enqueue(frames.next(EPOCH_A)).accepted).toBe(true);
    await writer.drain();
    base.files.set(`${directoryOf(EPOCH_B)}/${EPOCH_B}-000000.wal.jsonl`, Buffer.alloc(cap, 0x61));
    await writer.tick();
    expect(writer.metrics().totalSegmentBytes).toBeGreaterThan(cap);
    clock.advance(AGE_MS);
    await writer.tick();
    // Sealed, so expiry can remove it once it is old enough; waiting would
    // have saved nothing, since its footer is owed either way.
    expect(await closes(base)).toEqual([["time-rotation", 1]]);
    await writer.close();
    expect(writer.metrics().totalSegmentBytes).toBe(onDisk(base));
  });

  it("counts a waiting rotation once per segment, however many batches it waits through", async () => {
    const base = createMemoryFileSystem();
    const gated = gatedFileSystem(base);
    const clock = createManualClock();
    const frames = new Frames();
    const cap = 6_000;
    // One frame per batch: the rotation is decided again before every one.
    const writer = await openTimed(gated.fileSystem, clock, cap, { overrides: { fsyncByteThreshold: 1 } });
    const episode = async (): Promise<number> => {
      const first = frames.next(EPOCH_A);
      expect(writer.enqueue(first).accepted).toBe(true);
      const gate = gated.hold((call) => call.op === "append" && call.line === "frames", "before");
      const drain = writer.drain();
      expect(await suspended(gate, drain)).toBe(true);
      const admitted = 1 + offerUntilRefused(writer, frames, EPOCH_A).length;
      clock.advance(AGE_MS);
      gate.release();
      await drain;
      expectInvariants(writer, base, cap);
      await writer.tick();
      return admitted;
    };
    const firstEpisode = await episode();
    expect(firstEpisode).toBeGreaterThan(3);
    expect(writer.metrics().timeRotationsDeferred).toBe(1);
    // Expiry frees the first segment; the next one waits the same way.
    const [sealed] = await listSegmentManifests(base, directoryOf(EPOCH_A));
    if (sealed === undefined) throw new Error("no sealed segment");
    expire(base, directoryOf(EPOCH_A), sealed);
    await writer.tick();
    const secondEpisode = await episode();
    expect(secondEpisode).toBeGreaterThan(3);
    expect(writer.metrics().timeRotationsDeferred).toBe(2);
    expect((await closes(base)).map(([reason]) => reason)).toEqual(["time-rotation"]);
    await writer.close();
    expectInvariants(writer, base, cap);
  });

  it("holds the cap over random bursts, drains suspended anywhere, ticks and clock steps, with segments aging at any point", async () => {
    let seed = 0x7e57_0a6e;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    const pickOne = <T>(values: readonly T[]): T => {
      const value = values[Math.floor(random() * values.length)];
      if (value === undefined) throw new Error("nothing to pick from");
      return value;
    };
    const epochs = [EPOCH_A, EPOCH_B, EPOCH_C];
    const matchers: readonly ((call: GatedCall) => boolean)[] = [
      (call) => call.op === "openAppend",
      (call) => call.op === "append" && call.line === "header",
      (call) => call.op === "append" && call.line === "frames",
      (call) => call.op === "append" && call.line === "footer",
      (call) => call.op === "sync",
      (call) => call.op === "writeWholeFile",
    ];
    const seen = { suspensions: 0, agedWhileSuspended: 0, refusals: 0, timeRotations: 0, deferred: 0, expiries: 0, restarts: 0 };

    for (let run = 0; run < 100; run += 1) {
      const base = createMemoryFileSystem();
      const gated = gatedFileSystem(base);
      const clock = createManualClock();
      const frames = new Frames();
      const cap = pickOne([3_000, 6_000, 12_000, 20_000]);
      const segmentBytes = pickOne([1_500, 3_000, 64_000_000, 64_000_000]);
      const fsyncByteThreshold = pickOne([1, 1_000_000]);
      const open = async (epoch: string): Promise<WalWriter> =>
        openWalWriter({
          directoryPath: directoryOf(epoch),
          gatewayEpoch: epoch,
          fileSystem: gated.fileSystem,
          clock,
          maxTotalBytes: cap,
          capacityRootPath: ROOT,
          maxSegmentBytes: segmentBytes,
          maxSegmentAgeMs: AGE_MS,
          fsyncByteThreshold,
          observer: {
            onSegmentFinalized: (manifest) => {
              if (manifest.closeReason === "time-rotation") seen.timeRotations += 1;
            },
          },
        });
      const writers: WalWriter[] = [];
      let epochIndex = 0;
      let writer = await open(EPOCH_A);
      writers.push(writer);
      const offer = (epoch: string, count: number): void => {
        for (let index = 0; index < count; index += 1) {
          const result = writer.enqueue(frames.next(epoch, "x".repeat(Math.floor(random() * 300))));
          if (!result.accepted && result.reason === "capacity-exceeded") seen.refusals += 1;
        }
      };
      for (let step = 0; step < 50; step += 1) {
        const roll = random();
        const epoch = epochs[epochIndex] as string;
        if (roll < 0.5) {
          offer(epoch, 1 + Math.floor(random() * 6));
          if (random() < 0.3) clock.advance(pickOne([AGE_MS / 2, AGE_MS]));
          const gate = gated.hold(pickOne(matchers), random() < 0.5 ? "before" : "after");
          const drain = writer.drain();
          if (await suspended(gate, drain)) {
            seen.suspensions += 1;
            offer(epoch, Math.floor(random() * 8));
            if (random() < 0.5) {
              clock.advance(AGE_MS);
              seen.agedWhileSuspended += 1;
            }
            expect(onDisk(base), "mid-drain").toBeLessThanOrEqual(cap);
            gate.release();
          } else {
            gated.disarm();
          }
          await drain;
          await writer.drain();
        } else if (roll < 0.62) {
          clock.advance(pickOne([AGE_MS / 2, AGE_MS]));
        } else if (roll < 0.75) {
          await writer.tick();
        } else if (roll < 0.95) {
          const sealed: { directory: string; manifest: WalSegmentManifest }[] = [];
          for (const candidate of epochs) {
            for (const manifest of await listSegmentManifests(base, directoryOf(candidate))) {
              if (base.peek(`${directoryOf(candidate)}/${manifest.segmentFileName}`) !== undefined) {
                sealed.push({ directory: directoryOf(candidate), manifest });
              }
            }
          }
          const victim = sealed[Math.floor(random() * sealed.length)];
          if (victim !== undefined) {
            expire(base, victim.directory, victim.manifest);
            seen.expiries += 1;
          }
        } else if (epochIndex < epochs.length - 1) {
          if (random() < 0.7) await writer.close();
          seen.restarts += 1;
          epochIndex += 1;
          writer = await open(epochs[epochIndex] as string);
          writers.push(writer);
        }
        expectInvariants(writer, base, cap);
      }
      if (writer.state === "open") await writer.close();
      expectInvariants(writer, base, cap);
      for (const each of writers) {
        seen.deferred += each.metrics().timeRotationsDeferred;
      }
    }
    // Not vacuous: segments aged mid-drain and were closed by time, rotations
    // had to wait, expiry gave room back, and the cap refused frames
    // throughout (seeded: 474, 252, 368, 37, 509 and 7,512 when written).
    expect(seen.suspensions).toBeGreaterThan(350);
    expect(seen.agedWhileSuspended).toBeGreaterThan(180);
    expect(seen.timeRotations).toBeGreaterThan(250);
    expect(seen.deferred).toBeGreaterThan(20);
    expect(seen.expiries).toBeGreaterThan(300);
    expect(seen.refusals).toBeGreaterThan(5_000);
    expect(seen.restarts).toBeGreaterThan(100);
  });
});

/**
 * `WALCAP-1` round 2, finding N-1: the values a failed write's count falls
 * back to, and that the count is taken before the fault is raised, not after.
 */
describe("a failed write's count: its fallback values, and taken before the fault (r2, N-1)", () => {
  /** A memory filesystem whose next planned write fails, and whose next planned length read fails. */
  function failingWrites(base: MemoryFileSystem) {
    const plan: {
      append?: (bytes: Uint8Array) => Uint8Array;
      manifest?: true;
      headerSync?: true;
      failNextLengthRead?: true;
      /** Length reads answer only after a timer: a count not awaited lands after the fault. */
      slowLengthReads?: true;
    } = {};
    const synced = new Set<string>();
    const fileSystem: MemoryFileSystem = {
      ...base,
      openAppend: async (path) => {
        const handle = await base.openAppend(path);
        return {
          append: async (bytes) => {
            const tear = plan.append;
            if (tear !== undefined && lineOf(bytes) === "frames") {
              delete plan.append;
              await handle.append(tear(bytes));
              throw new Error("EIO (injected append)");
            }
            await handle.append(bytes);
          },
          sync: async () => {
            if (plan.headerSync === true && !synced.has(path)) {
              delete plan.headerSync;
              throw new Error("ENOSPC (injected fsync)");
            }
            synced.add(path);
            await handle.sync();
          },
          close: async () => handle.close(),
        };
      },
      writeWholeFile: async (path, bytes) => {
        if (plan.manifest === true && path.endsWith(".wal.manifest.json")) {
          delete plan.manifest;
          throw new Error("ENOSPC (injected sidecar)");
        }
        await base.writeWholeFile(path, bytes);
      },
      fileByteLength: async (path) => {
        if (plan.slowLengthReads === true) await new Promise<void>((resolve) => setTimeout(resolve, 5));
        if (plan.failNextLengthRead === true) {
          delete plan.failNextLengthRead;
          throw new Error("EIO (injected length read)");
        }
        return base.fileByteLength(path);
      },
    };
    return { fileSystem, plan };
  }

  it("a torn append whose length read fails too counts the segment as it was plus the whole batch", async () => {
    const base = createMemoryFileSystem();
    const { fileSystem, plan } = failingWrites(base);
    const frames = new Frames();
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A, { maxSegmentBytes: 100_000 });
    writer.enqueue(frames.next(EPOCH_A));
    await writer.drain();
    const before = writer.metrics().activeSegmentByteLength;
    let batch = 0;
    for (let index = 0; index < 3; index += 1) {
      const frame = frames.next(EPOCH_A);
      batch += frames.lineBytes.get(frame.ingestSeq) ?? Number.NaN;
      writer.enqueue(frame);
    }
    plan.append = (bytes) => bytes.subarray(0, Math.floor((bytes.length * 5) / 6));
    plan.failNextLengthRead = true;
    await expect(writer.drain()).rejects.toThrow();
    expect(plan.failNextLengthRead, "the fault path's length read was the one that failed").toBeUndefined();
    expect(writer.metrics().totalSegmentBytes).toBe(before + batch);
    expect(writer.metrics().totalSegmentBytes).toBeGreaterThanOrEqual(onDisk(base));
  });

  it("a failed finalize whose length read fails too counts the segment as it was plus the footer's reserve", async () => {
    const base = createMemoryFileSystem();
    const { fileSystem, plan } = failingWrites(base);
    const frames = new Frames();
    const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A);
    writer.enqueue(frames.next(EPOCH_A));
    await writer.drain();
    const before = writer.metrics().activeSegmentByteLength;
    // Nothing unwritten: the reservation is the open segment's footer alone.
    const footerReserve = writer.metrics().capacityReservedBytes ?? Number.NaN;
    plan.manifest = true;
    plan.failNextLengthRead = true;
    await expect(writer.rotate()).rejects.toThrow();
    expect(plan.failNextLengthRead, "the fault path's length read was the one that failed").toBeUndefined();
    expect(base.peek([...base.files.keys()].find((path) => path.endsWith(".wal.jsonl")) ?? "")?.toString("utf8")).toContain(
      '{"record":"footer"',
    );
    expect(writer.metrics().totalSegmentBytes).toBe(before + footerReserve);
    expect(writer.metrics().totalSegmentBytes).toBeGreaterThanOrEqual(onDisk(base));
  });

  for (const site of ["a torn append", "a segment whose header landed and whose creation failed"] as const) {
    it(`the count already holds what ${site} left when the fault is raised`, async () => {
      const base = createMemoryFileSystem();
      const { fileSystem, plan } = failingWrites(base);
      const frames = new Frames();
      const atFault: { counted: number; disk: number }[] = [];
      const late: { writer?: WalWriter } = {};
      const writer = await openEpoch(fileSystem, createManualClock(), EPOCH_A, {
        maxSegmentBytes: 100_000,
        observer: {
          onWriteFault: () => {
            atFault.push({ counted: late.writer?.metrics().totalSegmentBytes ?? Number.NaN, disk: onDisk(base) });
          },
        },
      });
      late.writer = writer;
      if (site === "a torn append") {
        writer.enqueue(frames.next(EPOCH_A));
        await writer.drain();
        plan.append = (bytes) => bytes.subarray(0, Math.floor(bytes.length / 2));
      } else {
        plan.headerSync = true;
      }
      writer.enqueue(frames.next(EPOCH_A));
      plan.slowLengthReads = true;
      await expect(writer.drain()).rejects.toThrow();
      expect(atFault).toHaveLength(1);
      const [fault] = atFault;
      expect(fault?.disk).toBeGreaterThan(0);
      expect(fault?.counted, "counted when the fault was raised").toBe(fault?.disk);
    });
  }
});

/** `WALCAP-1` round 2, finding N-2: in-flight frames that landed are not packed again. */
describe("the in-flight framing reserved is exactly what is still unwritten (r2, N-2)", () => {
  it("a drain held after its first batch landed reserves what a writer with the rest queued reserves", async () => {
    const options = { maxSegmentBytes: SEGMENT_BYTES, fsyncByteThreshold: 1 } as const;
    const big = "x".repeat(900);

    // Held: the big frame landed, two small ones still in flight.
    const heldBase = createMemoryFileSystem();
    const gated = gatedFileSystem(heldBase);
    const heldFrames = new Frames();
    const held = await openEpoch(gated.fileSystem, createManualClock(), EPOCH_A, options);
    held.enqueue(heldFrames.next(EPOCH_A));
    await held.drain();
    for (const payload of [big, undefined, undefined]) held.enqueue(heldFrames.next(EPOCH_A, payload));
    const gate = gated.hold((call) => call.op === "sync", "before");
    const drain = held.drain();
    expect(await suspended(gate, drain)).toBe(true);
    expect(framesOnDisk(heldBase).size, "the big frame landed").toBe(2);

    // At rest: the same frames on disk, the two small ones queued.
    const restBase = createMemoryFileSystem();
    const restFrames = new Frames();
    const rest = await openEpoch(restBase, createManualClock(), EPOCH_A, options);
    rest.enqueue(restFrames.next(EPOCH_A));
    await rest.drain();
    rest.enqueue(restFrames.next(EPOCH_A, big));
    await rest.drain();
    for (let index = 0; index < 2; index += 1) rest.enqueue(restFrames.next(EPOCH_A));
    expect(restBase.snapshot()).toStrictEqual(heldBase.snapshot());

    expect(held.metrics().capacityReservedBytes).toBe(rest.metrics().capacityReservedBytes);
    expect(held.metrics().capacityRemainingBytes).toBe(rest.metrics().capacityRemainingBytes);
    gate.release();
    await drain;
    await held.close();
    await rest.close();
    expect(restBase.snapshot()).toStrictEqual(heldBase.snapshot());
  });
});
