/**
 * The raw-frame journal: the gateway's ownership of the WP-050 WAL writer.
 *
 * ## Epoch handling (wal-format.md §2, WP-130 `CrossEpochOrderError`)
 *
 * A WAL writer owns exactly one gateway epoch, and the WP-130 compactor
 * REFUSES a directory whose verified segments span more than one epoch. The
 * journal therefore opens the writer on a PER-EPOCH SUBDIRECTORY,
 * `<walRoot>/<gatewayEpoch>`, so a restart (which mints a new epoch, §7.1)
 * starts a new directory instead of interleaving epochs in one — every
 * directory the compactor sees holds one epoch by construction. The
 * per-epoch directory also gives the journal exclusive ownership of its
 * directory (WP-050 `known_risks` 1: single-writer-per-directory is an
 * invariant the WAL does not enforce; a directory named by a fresh UUID has
 * exactly one writer that could know its name).
 *
 * ## Refusal is a halt signal (§8.3, ADR-004 §4)
 *
 * `record()` never drops and never blocks. A WAL refusal (queue overflow,
 * capacity, fault, closed) comes back as `{ recorded: false, … }` and the
 * caller — the feed driver — must treat it as WP-050's `follow_up` 4 directs:
 * open a `DataQualityIncidentOpened`, and do NOT publish normalized events
 * derived from the unrecorded frame (publishing data whose raw evidence was
 * refused would break the enqueue-before-publish invariant, acceptance 1).
 *
 * ## Duplicates on the fault path (WP-050 `known_risks` 3, `follow_up` 5)
 *
 * A faulted writer hands back every accepted-but-unmanifested frame through
 * `pendingFrames()`. Re-recording them into a fresh writer preserves each
 * frame's ORIGINAL `(gatewayEpoch, ingestSeq)` — the dedup identity — so a
 * later recovery of the abandoned segment produces duplicates that are
 * DETECTABLE by that key, never two facts with two identities. The journal
 * never re-stamps a frame.
 *
 * ## Cadence (WP-050 assumption 7 / `known_risks` 7)
 *
 * The writer schedules nothing; the gateway drives `drain()` after every
 * accepted enqueue and `tick()` on an interval at most the configured fsync
 * interval, so the published data-loss bound (`dataLossBoundMs`) is real.
 */

import type {
  RawFrameRecord,
  WalClock,
  WalEnqueueResult,
  WalFileSystem,
  WalWriter,
  WalWriterMetrics,
} from "@polymarket-bot/storage-wal";
import { buildRawFrameRecord, openWalWriter, WalError } from "@polymarket-bot/storage-wal";

import { GatewayStateError } from "./errors.js";
import type { GatewayClock, GatewayReceipt } from "./ports.js";
import type { IngestSequencer } from "./sequencer.js";

/** What a feed driver hands the journal for one exact wire frame. */
export interface RawFrameInput {
  /** §7.1 `source` vocabulary value (also the WAL record's `source`). */
  readonly source: string;
  /** Endpoint identifier — a URL or documented channel name, never a credential. */
  readonly endpoint: string;
  readonly connectionId: string;
  readonly subscriptionGeneration: number;
  readonly receipt: GatewayReceipt;
  /** The frame text, exactly as received. */
  readonly payloadUtf8: string;
}

export type RecordOutcome =
  | {
      readonly recorded: true;
      /** The frame's dedup identity within this epoch. */
      readonly ingestSeq: string;
    }
  | {
      readonly recorded: false;
      readonly reason: string;
      readonly detail: string;
      /** The frame still belongs to the caller; nothing was dropped. */
      readonly ingestSeq: string;
    };

export interface GatewayJournalOptions {
  readonly walRootPath: string;
  readonly fileSystem: WalFileSystem;
  readonly clock: GatewayClock;
  readonly sequencer: IngestSequencer;
  /** Passed through to the WAL writer. */
  readonly queueCapacity?: number;
  readonly queueMaxBytes?: number;
  readonly maxSegmentBytes?: number;
  readonly maxSegmentAgeMs?: number;
  readonly fsyncIntervalMs?: number;
  readonly fsyncByteThreshold?: number;
  readonly maxTotalBytes?: number | null;
  /** Called when the writer faults or refuses; the gateway opens the incident. */
  readonly onRecordingFailure?: (failure: {
    readonly reason: string;
    readonly detail: string;
  }) => void;
}

export class GatewayJournal {
  readonly #writer: WalWriter;
  readonly #sequencer: IngestSequencer;
  readonly #onFailure: GatewayJournalOptions["onRecordingFailure"];
  #draining: Promise<void> = Promise.resolve();
  #faulted = false;

  private constructor(writer: WalWriter, options: GatewayJournalOptions) {
    this.#writer = writer;
    this.#sequencer = options.sequencer;
    this.#onFailure = options.onRecordingFailure;
  }

  /** Opens (and recovers) the per-epoch WAL directory. */
  static async open(options: GatewayJournalOptions): Promise<GatewayJournal> {
    const gatewayEpoch = options.sequencer.gatewayEpoch;
    const directoryPath = options.fileSystem.joinPath(options.walRootPath, gatewayEpoch);
    const walClock: WalClock = {
      nowMs: () => options.clock.nowMs(),
      // The WAL wants monotonic milliseconds; the gateway clock provides
      // nanoseconds. Integer division loses sub-millisecond precision only.
      monotonicMs: () => Number(options.clock.monotonicNs() / 1_000_000n),
    };
    const writer = await openWalWriter({
      directoryPath,
      gatewayEpoch,
      fileSystem: options.fileSystem,
      clock: walClock,
      ...(options.queueCapacity === undefined ? {} : { queueCapacity: options.queueCapacity }),
      ...(options.queueMaxBytes === undefined ? {} : { queueMaxBytes: options.queueMaxBytes }),
      ...(options.maxSegmentBytes === undefined
        ? {}
        : { maxSegmentBytes: options.maxSegmentBytes }),
      ...(options.maxSegmentAgeMs === undefined
        ? {}
        : { maxSegmentAgeMs: options.maxSegmentAgeMs }),
      ...(options.fsyncIntervalMs === undefined
        ? {}
        : { fsyncIntervalMs: options.fsyncIntervalMs }),
      ...(options.fsyncByteThreshold === undefined
        ? {}
        : { fsyncByteThreshold: options.fsyncByteThreshold }),
      ...(options.maxTotalBytes === undefined ? {} : { maxTotalBytes: options.maxTotalBytes }),
    });
    return new GatewayJournal(writer, options);
  }

  /** True once a write fault has been observed; recording is no longer trusted. */
  get faulted(): boolean {
    return this.#faulted;
  }

  /**
   * Assigns the frame's ingest sequence and enqueues it for the WAL.
   *
   * SYNCHRONOUS on the accept/refuse decision (acceptance 1 needs "enqueued
   * before publication" to be a provable ordering, and an async refusal could
   * interleave with the publish). The disk write itself happens on the drain
   * this method schedules.
   */
  record(input: RawFrameInput): RecordOutcome {
    const ingestSeq = this.#sequencer.next();
    const record = buildRawFrameRecord({
      gatewayEpoch: this.#sequencer.gatewayEpoch,
      ingestSeq,
      source: input.source,
      endpoint: input.endpoint,
      connectionId: input.connectionId,
      subscriptionGeneration: input.subscriptionGeneration,
      receivedAt: input.receipt.receivedAt,
      receivedMonotonicNs: input.receipt.receivedMonotonicNs,
      payloadUtf8: input.payloadUtf8,
    });
    return this.#enqueue(record, ingestSeq);
  }

  /**
   * Re-enqueues frames a faulted writer handed back, into THIS journal.
   *
   * Identities are preserved: every frame keeps the `(gatewayEpoch,
   * ingestSeq)` it was first assigned, and a frame whose identity this epoch
   * never assigned is refused loudly — re-stamping would mint a second
   * identity for one fact. Only meaningful when the replacement journal shares
   * the epoch (same process, fresh directory is not possible — the directory
   * is the epoch — so this re-enqueues into the same writer after a transient
   * refusal, or documents the restart path where a NEW epoch must not adopt
   * old identities at all).
   */
  reenqueuePending(frames: readonly RawFrameRecord[]): readonly RecordOutcome[] {
    return frames.map((frame) => {
      if (frame.gatewayEpoch !== this.#sequencer.gatewayEpoch) {
        throw new GatewayStateError(
          "a pending frame from another epoch cannot be re-recorded under this one; recover its own directory instead (wal-format.md §2)",
          { frameEpoch: frame.gatewayEpoch, journalEpoch: this.#sequencer.gatewayEpoch },
        );
      }
      this.#sequencer.assertAssigned(frame.ingestSeq);
      return this.#enqueue(frame, frame.ingestSeq);
    });
  }

  #enqueue(record: RawFrameRecord, ingestSeq: string): RecordOutcome {
    let result: WalEnqueueResult;
    try {
      result = this.#writer.enqueue(record);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.#onFailure?.({ reason: "validation-rejected", detail });
      return { recorded: false, reason: "validation-rejected", detail, ingestSeq };
    }
    if (!result.accepted) {
      this.#onFailure?.({ reason: result.reason, detail: result.detail });
      return { recorded: false, reason: result.reason, detail: result.detail, ingestSeq };
    }
    this.#scheduleDrain();
    return { recorded: true, ingestSeq };
  }

  /** Serializes drains so two enqueues cannot interleave writer calls. */
  #scheduleDrain(): void {
    this.#draining = this.#draining.then(async () => {
      if (this.#faulted) return;
      try {
        await this.#writer.drain();
      } catch (error) {
        this.#noteFault(error);
      }
    });
  }

  /** Time-driven fsync and rotation; call on an interval ≤ the fsync interval. */
  async tick(): Promise<void> {
    await this.#draining;
    if (this.#faulted) return;
    try {
      await this.#writer.tick();
    } catch (error) {
      this.#noteFault(error);
    }
  }

  /** Waits for all scheduled drains to settle (test and shutdown support). */
  async settle(): Promise<void> {
    await this.#draining;
  }

  /** Frames the writer is still answerable for after a fault. */
  pendingFrames(): readonly RawFrameRecord[] {
    return this.#writer.pendingFrames();
  }

  metrics(): WalWriterMetrics {
    return this.#writer.metrics();
  }

  async close(): Promise<void> {
    await this.#draining;
    try {
      await this.#writer.close();
    } catch (error) {
      this.#noteFault(error);
    }
  }

  #noteFault(error: unknown): void {
    this.#faulted = true;
    const detail =
      error instanceof WalError
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    this.#onFailure?.({ reason: "write-fault", detail });
  }
}
