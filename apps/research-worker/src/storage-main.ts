/**
 * The storage command's entry point (`STORAGE-1`): one storage cycle —
 * research tier, classification, pins, expiry plan — printed as one JSON
 * report.
 *
 * ```text
 * RESEARCH_WORKER_WAL_ROOT=/var/lib/polymarket-bot/wal
 * RESEARCH_WORKER_OBJECT_STORE_ROOT=/var/lib/polymarket-bot/objects
 * pnpm --filter @polymarket-bot/research-worker start storage
 * ```
 *
 * It ships inside the worker's one bundle (`dist/main.mjs storage`), loaded
 * only when that command is given; `main.ts` dispatches to it.
 *
 * **Dry run by default**: nothing is deleted and no plan is written unless
 * `RESEARCH_WORKER_EXPIRY_MODE=execute`, a state directory is configured, and
 * the WAL root holds the expiry opt-in marker (`storage-config.ts`).
 *
 * The composition root: the only place that reads the environment, opens the
 * filesystem and the trader database (read-only), and chooses the deletion
 * capability.
 */

import type { ExpiredSegmentDeletion } from "@polymarket-bot/storage-parquet";
import {
  ensureDirectory,
  expireAfterExtractDeletion,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
  systemCompactionClock,
} from "@polymarket-bot/storage-parquet";
import { createDatabase, createPostgresPool } from "@polymarket-bot/storage-postgres";

import type { TraderEvidenceSource } from "./retention/classify.js";
import { staticEvidenceSource } from "./retention/classify.js";
import { systemBootClock } from "./retention/clock-guard.js";
import { runStorageCycle } from "./retention/cycle.js";
import type { StorageCycleReport } from "./retention/cycle.js";
import { postgresTraderEvidence } from "./retention/evidence-postgres.js";
import { noOperatorPinLock, operatorPinFile, publishOperatorPin } from "./retention/operator-pin-lock.js";
import { loadOperatorPins, loadWindowRegistry } from "./retention/windows.js";
import { loadStorageConfig } from "./storage-config.js";

function lockOptions(options: StorageMainOptions): { readonly timeoutMs?: number } {
  return options.operatorPinLockTimeoutMs === undefined ? {} : { timeoutMs: options.operatorPinLockTimeoutMs };
}

/** The report, reduced to what an operator reads: no record bodies. */
export function summarizeStorageReport(report: StorageCycleReport): Record<string, unknown> {
  return {
    event: "storage-cycle",
    mode: report.mode,
    extraction: {
      datasets: report.extraction.datasets,
      refused: report.extraction.refused,
      segmentsExtracted: report.extraction.segmentsExtracted,
      framesRead: report.extraction.framesRead,
      uninterpretedByCategory: Object.fromEntries(report.extraction.uninterpretedByCategory),
    },
    classifications: report.classifications.map((classification) =>
      classification.state === "unclassified"
        ? { windowId: classification.windowId, state: classification.state, reason: classification.reason }
        : {
            windowId: classification.windowId,
            state: classification.state,
            pinClass: classification.pinClass,
            evidenceCounts: classification.evidenceCounts,
          },
    ),
    pins: report.pins.map((outcome) =>
      outcome.status === "waiting"
        ? outcome
        : {
            pinId: outcome.pinId,
            status: outcome.status,
            pinClass: outcome.record.pinClass,
            from: outcome.record.from,
            to: outcome.record.to,
            keepUntil: outcome.record.keepUntil,
            sourceEventsInside: outcome.record.sourceEventsInside,
            datasets: outcome.record.datasets.map((dataset) => ({
              datasetId: dataset.datasetId,
              segments: dataset.segmentIds.length,
              objectBytes: dataset.objectBytes,
            })),
          },
    ),
    pinFailures: report.pinFailures,
    segments: report.decisions.map((decision) => ({
      segmentId: decision.segment.segmentId,
      eligible: decision.eligible,
      maxReceivedAt: decision.maxReceivedAt,
      reasons: decision.reasons,
    })),
    expiry:
      report.expiry === null
        ? null
        : {
            planId: report.expiry.planId,
            deleted: report.expiry.deleted.map((deletion) => deletion.segmentId),
            failures: report.expiry.failures,
            receiptObjectKey: report.expiry.receiptObjectKey,
          },
    metrics: report.metrics,
  };
}

/** What a test may shorten in the composition root; the command passes nothing. */
export type StorageMainOptions = {
  /** How long to wait for the operator-pin lock (default 120 s). */
  readonly operatorPinLockTimeoutMs?: number;
};

/** Run one storage cycle and print its report. */
export async function storageMain(options: StorageMainOptions = {}): Promise<number> {
  const config = loadStorageConfig();
  const objectStore = fileSystemObjectStore(config.objectStoreRoot);
  await ensureDirectory(config.objectStoreRoot);

  // The operator's pin file by its canonical path, and the lock beside it:
  // the same lock the `storage pin` command takes, however either spells it.
  const pinFile =
    config.operatorPinsPath === null
      ? null
      : await operatorPinFile(config.operatorPinsPath, lockOptions(options));

  let evidence: TraderEvidenceSource;
  let close: () => Promise<void> = async () => {};
  if (config.traderDatabaseUrl === null) {
    // No trader database: no trader-responsible window can be classified, so
    // none of the segments it overlaps can expire. Fail closed.
    evidence = staticEvidenceSource({ frontiers: new Map(), evidence: new Map() });
  } else {
    const pool = createPostgresPool({
      connectionString: config.traderDatabaseUrl,
      applicationName: "polymarket-bot-research-worker-storage",
      maxConnections: 2,
    });
    const db = createDatabase(pool);
    evidence = postgresTraderEvidence(db, { environment: config.traderEnvironment });
    close = async () => {
      await db.destroy();
    };
  }

  let deletion: ExpiredSegmentDeletion | null = null;
  if (config.mode === "execute") {
    deletion = expireAfterExtractDeletion({ walRootPath: config.walRootPath, objectStore });
  }

  try {
    const report = await runStorageCycle({
      walRootPath: config.walRootPath,
      objectStore,
      fileSystem: nodeCompactionFileSystem(),
      clock: systemCompactionClock(),
      evidence,
      loadWindows: () => loadWindowRegistry(config.windowRegistryPath),
      loadOperatorPins: () => loadOperatorPins(pinFile === null ? null : pinFile.path),
      settings: {
        retentionMs: config.retentionMs,
        leadInMs: config.leadInMs,
        durabilityGraceMs: config.durabilityGraceMs,
        pinBudgetBytesPerDay: config.pinBudgetBytesPerDay,
        expiryStuckAfterMs: config.expiryStuckAfterMs,
        walMaxTotalBytes: config.walMaxTotalBytes,
        maxSegmentsPerDataset: config.maxSegmentsPerDataset,
        extractionBatchDelayMs: config.extractionBatchDelayMs,
        clockStepToleranceMs: config.clockStepToleranceMs,
      },
      mode: config.mode,
      deletion,
      stateDirectory: config.stateDirectory,
      bootClock: systemBootClock(),
      operatorPinLock: pinFile === null ? noOperatorPinLock() : pinFile.lock,
    });
    console.log(JSON.stringify(summarizeStorageReport(report)));
    return report.expiry !== null && report.expiry.failures.length > 0 ? 1 : 0;
  } finally {
    await close();
  }
}

/**
 * `storage pin <pinId> <from> <to> <reason>`: publish one operator pin under
 * the operator-pin lock (`operator-pin-lock.ts`), so it is serialized with
 * every expiry's final check and unlink. Reads `RESEARCH_WORKER_OPERATOR_PINS`.
 * A pin added by editing the file by hand is re-read before each unlink, but
 * only this command is serialized with the unlink itself.
 */
export async function storagePinMain(argv: readonly string[], options: StorageMainOptions = {}): Promise<number> {
  const [pinId, from, to, ...reasonWords] = argv;
  const path = process.env["RESEARCH_WORKER_OPERATOR_PINS"]?.trim() ?? "";
  if (pinId === undefined || from === undefined || to === undefined || reasonWords.length === 0 || path.length === 0) {
    console.error(
      "usage: RESEARCH_WORKER_OPERATOR_PINS=<file> main.mjs storage pin <pinId> <from ISO-8601> <to ISO-8601> <reason>",
    );
    return 2;
  }
  const pinFile = await operatorPinFile(path, lockOptions(options));
  const pins = await publishOperatorPin({
    operatorPinsPath: pinFile.path,
    lock: pinFile.lock,
    pin: { pinId, from, to, reason: reasonWords.join(" ") },
  });
  console.log(JSON.stringify({ event: "operator-pin-published", pinId, pins: pins.length }));
  return 0;
}
