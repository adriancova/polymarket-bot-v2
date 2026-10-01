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
import { runStorageCycle } from "./retention/cycle.js";
import type { StorageCycleReport } from "./retention/cycle.js";
import { postgresTraderEvidence } from "./retention/evidence-postgres.js";
import { loadOperatorPins, loadWindowRegistry } from "./retention/windows.js";
import { loadStorageConfig } from "./storage-config.js";

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

/** Run one storage cycle and print its report. */
export async function storageMain(): Promise<number> {
  const config = loadStorageConfig();
  const objectStore = fileSystemObjectStore(config.objectStoreRoot);
  await ensureDirectory(config.objectStoreRoot);

  let evidence: TraderEvidenceSource;
  let close: () => Promise<void> = async () => {};
  if (config.traderDatabaseUrl === null) {
    // No trader database: no trader-responsible window can be classified, so
    // none of the segments it overlaps can expire. Fail closed.
    evidence = staticEvidenceSource({ durableThroughMs: new Map(), evidence: new Map() });
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
      loadOperatorPins: () => loadOperatorPins(config.operatorPinsPath),
      settings: {
        retentionMs: config.retentionMs,
        leadInMs: config.leadInMs,
        durabilityGraceMs: config.durabilityGraceMs,
        pinBudgetBytesPerDay: config.pinBudgetBytesPerDay,
        expiryStuckAfterMs: config.expiryStuckAfterMs,
        walMaxTotalBytes: config.walMaxTotalBytes,
        maxSegmentsPerDataset: config.maxSegmentsPerDataset,
        extractionBatchDelayMs: config.extractionBatchDelayMs,
      },
      mode: config.mode,
      deletion,
      stateDirectory: config.stateDirectory,
    });
    console.log(JSON.stringify(summarizeStorageReport(report)));
    return report.expiry !== null && report.expiry.failures.length > 0 ? 1 : 0;
  } finally {
    await close();
  }
}
