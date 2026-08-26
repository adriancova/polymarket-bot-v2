/**
 * One open segment file.
 *
 * Owns the append handle, the running SHA-256, the record count, and the
 * fsync accounting for exactly one segment. It knows nothing about queues,
 * rotation policy, or recovery — those belong to {@link WalWriter} — which keeps
 * "what is in this file" separable from "when do we start a new one".
 *
 * Counters advance only **after** a successful append, so a torn write leaves
 * the in-memory state describing the last known-good prefix rather than a
 * fiction. The writer's fault path relies on that.
 */

import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";

import { isoFromEpochMs } from "./clock.js";
import { WAL_FORMAT_ID, WAL_MANIFEST_VERSION, WAL_SCHEMA_VERSION } from "./constants.js";
import { segmentFileName, writeSegmentManifest } from "./manifest.js";
import type { WalSegmentManifest } from "./manifest.js";
import type { WalAppendHandle, WalClock, WalCloseReason, WalFileSystem } from "./ports.js";
import type { QueuedFrame } from "./queue.js";
import { encodeFooterLine, encodeHeaderLine } from "./segment-format.js";
import type { WalSegmentFooter, WalSegmentHeader } from "./segment-format.js";

export class ActiveSegment {
  readonly header: WalSegmentHeader;
  readonly path: string;
  readonly openedAtMs: number;
  readonly openedMonotonicMs: number;

  readonly #fileSystem: WalFileSystem;
  readonly #directoryPath: string;
  readonly #handle: WalAppendHandle;
  readonly #hash: Hash;

  #recordCount = 0;
  #durableRecordCount = 0;
  #byteLength = 0;
  #checksummedByteLength = 0;
  #unsyncedBytes = 0;
  #unsyncedRecords = 0;
  #lastSyncMonotonicMs: number;
  #firstIngestSeq: string | null = null;
  #lastIngestSeq: string | null = null;
  #firstReceivedAt: string | null = null;
  #lastReceivedAt: string | null = null;
  #closed = false;
  #faultSyncAttempted = false;
  #faultSyncSucceeded = false;

  private constructor(input: {
    readonly fileSystem: WalFileSystem;
    readonly directoryPath: string;
    readonly handle: WalAppendHandle;
    readonly header: WalSegmentHeader;
    readonly path: string;
    readonly openedAtMs: number;
    readonly openedMonotonicMs: number;
  }) {
    this.#fileSystem = input.fileSystem;
    this.#directoryPath = input.directoryPath;
    this.#handle = input.handle;
    this.header = input.header;
    this.path = input.path;
    this.openedAtMs = input.openedAtMs;
    this.openedMonotonicMs = input.openedMonotonicMs;
    this.#hash = createHash("sha256");
    this.#lastSyncMonotonicMs = input.openedMonotonicMs;
  }

  /**
   * Create the file and write its header (§9.1: the header carries the schema
   * version and the gateway epoch).
   *
   * The header is fsynced immediately. It is one small write, and it is what
   * makes a segment identifiable if the process dies a millisecond later.
   */
  static async open(input: {
    readonly fileSystem: WalFileSystem;
    readonly directoryPath: string;
    readonly header: WalSegmentHeader;
    readonly clock: WalClock;
  }): Promise<ActiveSegment> {
    const path = input.fileSystem.joinPath(
      input.directoryPath,
      segmentFileName(input.header.segmentId),
    );
    const handle = await input.fileSystem.openAppend(path);
    const segment = new ActiveSegment({
      fileSystem: input.fileSystem,
      directoryPath: input.directoryPath,
      handle,
      header: input.header,
      path,
      openedAtMs: input.clock.nowMs(),
      openedMonotonicMs: input.clock.monotonicMs(),
    });
    const headerBytes = encodeHeaderLine(input.header);
    try {
      await handle.append(headerBytes);
      segment.#hash.update(headerBytes);
      segment.#byteLength += headerBytes.length;
      segment.#checksummedByteLength += headerBytes.length;
      await handle.sync();
      segment.#lastSyncMonotonicMs = input.clock.monotonicMs();
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
    return segment;
  }

  get segmentId(): string {
    return this.header.segmentId;
  }

  get recordCount(): number {
    return this.#recordCount;
  }

  /**
   * Records whose durability has been **proven** by a successful `fsync`.
   *
   * The writer's fault reconciliation partitions the frames it accepted using
   * this number: records beyond it may be on disk, but nothing has proven they
   * survive a power loss, so they are not reported as durable and they are not
   * removed from the caller's pending list until a later `fsync` proves them.
   */
  get durableRecordCount(): number {
    return this.#durableRecordCount;
  }

  get byteLength(): number {
    return this.#byteLength;
  }

  get checksummedByteLength(): number {
    return this.#checksummedByteLength;
  }

  get unsyncedBytes(): number {
    return this.#unsyncedBytes;
  }

  get unsyncedRecords(): number {
    return this.#unsyncedRecords;
  }

  get lastSyncMonotonicMs(): number {
    return this.#lastSyncMonotonicMs;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Append a batch of already-encoded frames in one write. */
  async appendFrames(frames: readonly QueuedFrame[]): Promise<number> {
    if (this.#closed) {
      throw new Error(`segment ${this.segmentId} is closed`);
    }
    if (frames.length === 0) {
      return 0;
    }
    const payload =
      frames.length === 1
        ? Buffer.from(frames[0]?.bytes ?? new Uint8Array())
        : Buffer.concat(frames.map((frame) => Buffer.from(frame.bytes)));

    await this.#handle.append(payload);

    // Only now, after the append resolved, does in-memory state advance.
    this.#hash.update(payload);
    this.#byteLength += payload.length;
    this.#checksummedByteLength += payload.length;
    this.#unsyncedBytes += payload.length;
    this.#unsyncedRecords += frames.length;
    this.#recordCount += frames.length;
    for (const frame of frames) {
      if (this.#firstIngestSeq === null) {
        this.#firstIngestSeq = frame.record.ingestSeq;
        this.#firstReceivedAt = frame.record.receivedAt;
      }
      this.#lastIngestSeq = frame.record.ingestSeq;
      this.#lastReceivedAt = frame.record.receivedAt;
    }
    return payload.length;
  }

  /** fsync the segment. Returns the bytes and records made durable. */
  async sync(clock: WalClock): Promise<{ readonly bytes: number; readonly records: number }> {
    const bytes = this.#unsyncedBytes;
    const records = this.#unsyncedRecords;
    await this.#handle.sync();
    this.#unsyncedBytes = 0;
    this.#unsyncedRecords = 0;
    this.#durableRecordCount = this.#recordCount;
    this.#lastSyncMonotonicMs = clock.monotonicMs();
    return { bytes, records };
  }

  /**
   * Last chance to prove the file durable, on the fault path.
   *
   * Always issues an `fsync` when the handle is still open, even when the
   * in-memory counters believe nothing is unsynced: after a torn append the
   * counters describe the last known-good prefix, while the file may hold more
   * bytes than that. Returns `true` when everything currently in the file is
   * known to have reached durable storage.
   *
   * A released handle implies `true`, because {@link ActiveSegment.finalize}
   * releases the handle only after a successful `fsync`.
   *
   * Never throws: the caller is already handling a fault, and the answer it
   * needs is a verdict, not another exception. The result is remembered so a
   * retried close cannot turn a failed sync into an apparent success.
   */
  async syncForFaultClose(): Promise<boolean> {
    if (this.#faultSyncAttempted) {
      return this.#faultSyncSucceeded;
    }
    this.#faultSyncAttempted = true;
    if (this.#closed) {
      this.#faultSyncSucceeded = true;
      return true;
    }
    try {
      await this.#handle.sync();
      this.#unsyncedBytes = 0;
      this.#unsyncedRecords = 0;
      this.#durableRecordCount = this.#recordCount;
      this.#faultSyncSucceeded = true;
    } catch {
      this.#faultSyncSucceeded = false;
    }
    return this.#faultSyncSucceeded;
  }

  /**
   * Close the segment: footer, fsync, sidecar manifest.
   *
   * Both forms ADR-004 §2 allows are written for a cleanly closed segment — the
   * in-file footer, and the sidecar that a crash-closed segment would have to
   * rely on. They must agree; {@link validateSegment} checks that they do.
   */
  async finalize(reason: WalCloseReason, clock: WalClock): Promise<WalSegmentManifest> {
    if (this.#closed) {
      throw new Error(`segment ${this.segmentId} is already closed`);
    }
    const closedAtMs = clock.nowMs();
    const segmentSha256 = this.#hash.digest("hex");
    const footer: WalSegmentFooter = {
      record: "footer",
      formatId: WAL_FORMAT_ID,
      walSchemaVersion: WAL_SCHEMA_VERSION,
      segmentId: this.header.segmentId,
      gatewayEpoch: this.header.gatewayEpoch,
      recordCount: this.#recordCount,
      checksummedByteLength: this.#checksummedByteLength,
      segmentSha256,
      closedAt: isoFromEpochMs(closedAtMs),
      closeReason: reason,
    };
    const footerBytes = encodeFooterLine(footer);
    // The handle is deliberately **not** released when the footer append or its
    // fsync fails: the writer's fault path still needs it to prove what reached
    // the disk. Releasing it here would leave the segment unsyncable and force
    // the manifest to describe bytes nobody had fsynced.
    await this.#handle.append(footerBytes);
    this.#byteLength += footerBytes.length;
    this.#unsyncedBytes += footerBytes.length;
    await this.#handle.sync();
    this.#unsyncedBytes = 0;
    this.#unsyncedRecords = 0;
    this.#durableRecordCount = this.#recordCount;
    this.#lastSyncMonotonicMs = clock.monotonicMs();
    this.#closed = true;
    await this.#handle.close().catch(() => undefined);

    const manifest: WalSegmentManifest = {
      manifestVersion: WAL_MANIFEST_VERSION,
      formatId: WAL_FORMAT_ID,
      walSchemaVersion: WAL_SCHEMA_VERSION,
      segmentId: this.header.segmentId,
      gatewayEpoch: this.header.gatewayEpoch,
      segmentIndex: this.header.segmentIndex,
      segmentFileName: segmentFileName(this.header.segmentId),
      recordCount: this.#recordCount,
      firstIngestSeq: this.#firstIngestSeq,
      lastIngestSeq: this.#lastIngestSeq,
      firstReceivedAt: this.#firstReceivedAt,
      lastReceivedAt: this.#lastReceivedAt,
      byteSize: this.#byteLength,
      checksummedByteLength: this.#checksummedByteLength,
      segmentSha256,
      createdAt: this.header.createdAt,
      closedAt: footer.closedAt,
      closeReason: reason,
      footerPresent: true,
      truncatedTailBytes: 0,
    };
    await writeSegmentManifest(this.#fileSystem, this.#directoryPath, manifest);
    return manifest;
  }

  /** Release the handle without writing a footer (fault path). */
  async abandon(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#handle.close().catch(() => undefined);
  }
}
