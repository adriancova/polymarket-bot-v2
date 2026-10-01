/**
 * Disk, pin-budget and expiry-lag metrics (`STORAGE-1` deliverable 4;
 * ADR-028 Decisions 3.6 and 5; `docs/handoffs/LEAN-1.md` §8).
 *
 * LEAN-1 §8 pages on "disk above 85%", "`maxTotalBytes` is near" and "expiry
 * is stuck", and notifies on "pin budget exceeded". Each is computed here as
 * a typed value an exporter can publish, with its definition spelled out:
 *
 * - **expiry lag** — for every sealed segment still on disk that reached the
 *   retention age (its newest frame is older than 72 h), how long ago it
 *   reached it; the metric is the largest. `null` when no such segment is
 *   left. A segment kept for a reason (a pin not extracted, a window not
 *   classified, a stopped trader) shows here: that is what "stuck" means. A
 *   segment whose research tier is missing or does not verify has no verified
 *   age, so its sidecar's `closedAt` stands in: a broken extract path is
 *   stuck too (`SegmentDecision.retentionDueAtMs`).
 * - **expiry stuck** — the lag exceeds a threshold. It deletes nothing.
 * - **pin budget** — bytes of pins **recorded** on the current UTC day,
 *   against a daily budget (3 GB at 1-2 markets, 6 GB at 8; ADR-028 Decision
 *   3.6). Exceeding it **only alarms**: no pin is evicted, shrunk or skipped
 *   for it (Decision 3.7, "evidence is never deleted to meet a budget").
 * - **disk** — the WAL filesystem's free and total bytes (`statfs`), with the
 *   85% alarm.
 * - **WAL capacity** — when the operator states the gateway's `maxTotalBytes`,
 *   what the WAL WRITER counts against it, with a 90% "near" alarm. The
 *   writer (`packages/storage-wal`, `#totalSegmentBytes`) counts every byte it
 *   wrote in its epoch and never subtracts a deleted segment, so expiry does
 *   not give it room back: the metric is, per epoch, the bytes of its sealed
 *   segments on disk plus those of its segments this worker expired (from the
 *   durable plans), and the largest epoch is compared with `maxTotalBytes`.
 *   The open segment (at most `maxSegmentBytes`) is not counted. The bytes on
 *   disk are reported beside it.
 *
 * None of these triggers deletion: expiry never runs early to make room
 * (Decision 5.4).
 */

import { statfs } from "node:fs/promises";

import type { ClockAssessment } from "./clock-guard.js";
import type { SegmentDecision } from "./plan.js";
import { reasonClass } from "./plan.js";
import type { PinRecord } from "./pins.js";

/** ADR-028 Decision 3.6: 3 GB a day at 1-2 markets. */
export const DEFAULT_PIN_BUDGET_BYTES_PER_DAY = 3 * 1000 * 1000 * 1000;
/** LEAN-1 §8: page above 85% disk use. */
export const DISK_ALARM_FRACTION = 0.85;
/** "`maxTotalBytes` is near": 90% of it. */
export const WAL_CAPACITY_ALARM_FRACTION = 0.9;

export type DiskMetrics = {
  readonly path: string;
  readonly totalBytes: number;
  readonly freeBytes: number;
  readonly usedFraction: number;
  readonly alarm: boolean;
};

export type StorageMetrics = {
  readonly walSegmentsSealed: number;
  readonly walBytesSealed: number;
  readonly walSegmentsUnreadable: number;
  /** Sidecars whose segment is gone (a deletion interrupted between its two unlinks). */
  readonly walOrphanSidecars: number;
  readonly segmentsEligible: number;
  readonly segmentsKeptByReason: Readonly<Record<string, number>>;
  /** The largest time, in ms, a segment has been past retention age and still on disk. */
  readonly expiryLagMs: number | null;
  readonly expiryStuck: boolean;
  readonly disk: DiskMetrics | null;
  readonly walCapacity: {
    readonly maxTotalBytes: number;
    /** Sealed WAL bytes on disk, every epoch. */
    readonly sealedBytesOnDisk: number;
    /** The epoch whose writer has counted the most bytes, and that count (on disk plus expired). */
    readonly largestEpoch: string | null;
    readonly largestEpochWrittenBytes: number;
    /** `maxTotalBytes` less that count: the room the writer still sees. */
    readonly headroomBytes: number;
    readonly alarm: boolean;
  } | null;
  /** The clock guard's reading (`clock-guard.ts`); `skewMs` is subtracted from the wall clock. */
  readonly clock: ClockAssessment;
  readonly pinBudget: {
    readonly day: string;
    readonly bytesPinnedToday: number;
    readonly budgetBytesPerDay: number;
    /** An alarm only: nothing is evicted or reduced for it. */
    readonly exceeded: boolean;
  };
  readonly pinsTotal: number;
  readonly pinBytesTotal: number;
  readonly expiryPlansWithoutReceipt: number;
  /** Durable plans that do not read: the capacity figure may be low while any exist. */
  readonly expiryPlansUnreadable: number;
};

/** The largest lag past retention age among segments still on disk. */
export function expiryLagMs(decisions: readonly SegmentDecision[], nowMs: number): number | null {
  let lag: number | null = null;
  for (const decision of decisions) {
    const dueAtMs = decision.retentionDueAtMs;
    if (dueAtMs === null || dueAtMs > nowMs) continue;
    const past = nowMs - dueAtMs;
    lag = lag === null ? past : Math.max(lag, past);
  }
  return lag;
}

/** Bytes of pins recorded on `nowMs`'s UTC day, against the budget. An alarm only. */
export function pinBudget(
  records: readonly PinRecord[],
  nowMs: number,
  budgetBytesPerDay: number,
): StorageMetrics["pinBudget"] {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const bytesPinnedToday = records
    .filter((record) => record.createdAt.slice(0, 10) === day)
    .reduce((sum, record) => sum + record.datasets.reduce((inner, dataset) => inner + dataset.objectBytes, 0), 0);
  return { day, bytesPinnedToday, budgetBytesPerDay, exceeded: bytesPinnedToday > budgetBytesPerDay };
}

/** The filesystem holding `path`. `null` when it cannot be read. */
export async function diskMetrics(path: string): Promise<DiskMetrics | null> {
  try {
    const stats = await statfs(path);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    const usedFraction = totalBytes === 0 ? 0 : (totalBytes - freeBytes) / totalBytes;
    return { path, totalBytes, freeBytes, usedFraction, alarm: usedFraction >= DISK_ALARM_FRACTION };
  } catch {
    return null;
  }
}

/** Assemble the storage metrics of one cycle. */
export function storageMetrics(input: {
  readonly nowMs: number;
  readonly decisions: readonly SegmentDecision[];
  readonly walSegmentsUnreadable: number;
  readonly walOrphanSidecars: number;
  readonly walBytesSealed: number;
  /** Per epoch, the bytes its writer has counted: sealed on disk plus expired by this worker. */
  readonly walEpochWrittenBytes: ReadonlyMap<string, number>;
  readonly disk: DiskMetrics | null;
  readonly walMaxTotalBytes: number | null;
  readonly clock: ClockAssessment;
  readonly pinRecords: readonly PinRecord[];
  readonly pinBudgetBytesPerDay: number;
  readonly expiryStuckAfterMs: number;
  readonly expiryPlansWithoutReceipt: number;
  readonly expiryPlansUnreadable?: number;
}): StorageMetrics {
  const keptByReason: Record<string, number> = {};
  for (const decision of input.decisions) {
    for (const reason of new Set(decision.reasons.map(reasonClass))) {
      keptByReason[reason] = (keptByReason[reason] ?? 0) + 1;
    }
  }
  const lag = expiryLagMs(input.decisions, input.nowMs);
  let largestEpoch: string | null = null;
  let largestEpochWrittenBytes = 0;
  for (const [epoch, bytes] of input.walEpochWrittenBytes) {
    if (bytes > largestEpochWrittenBytes) {
      largestEpoch = epoch;
      largestEpochWrittenBytes = bytes;
    }
  }
  return {
    walSegmentsSealed: input.decisions.length,
    walBytesSealed: input.walBytesSealed,
    walSegmentsUnreadable: input.walSegmentsUnreadable,
    walOrphanSidecars: input.walOrphanSidecars,
    segmentsEligible: input.decisions.filter((decision) => decision.eligible).length,
    segmentsKeptByReason: keptByReason,
    expiryLagMs: lag,
    expiryStuck: lag !== null && lag > input.expiryStuckAfterMs,
    disk: input.disk,
    walCapacity:
      input.walMaxTotalBytes === null
        ? null
        : {
            maxTotalBytes: input.walMaxTotalBytes,
            sealedBytesOnDisk: input.walBytesSealed,
            largestEpoch,
            largestEpochWrittenBytes,
            headroomBytes: input.walMaxTotalBytes - largestEpochWrittenBytes,
            alarm: largestEpochWrittenBytes >= input.walMaxTotalBytes * WAL_CAPACITY_ALARM_FRACTION,
          },
    clock: input.clock,
    pinBudget: pinBudget(input.pinRecords, input.nowMs, input.pinBudgetBytesPerDay),
    pinsTotal: input.pinRecords.length,
    pinBytesTotal: input.pinRecords.reduce(
      (sum, record) => sum + record.datasets.reduce((inner, dataset) => inner + dataset.objectBytes, 0),
      0,
    ),
    expiryPlansWithoutReceipt: input.expiryPlansWithoutReceipt,
    expiryPlansUnreadable: input.expiryPlansUnreadable ?? 0,
  };
}
