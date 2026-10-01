/**
 * The research worker's process entry point.
 *
 * This is the composition root (`docs/contracts/dependency-direction.md` §2,
 * layer 3): the only place that reads the environment, opens a filesystem, and
 * decides which retention policy is in force. Everything below it takes ports.
 *
 * It performs **no venue call, holds no credential, and places no order**, so
 * it neither reads nor influences `MAX_RUN_MODE`, `ALLOW_REAL_ORDERS`, or the
 * live-micro caps.
 */

import {
  deleteAfterVerifiedUploadRetention,
  ensureDirectory,
  fileSystemObjectStore,
  nodeCompactionFileSystem,
  retainAllWalSegments,
  systemCompactionClock,
} from "@polymarket-bot/storage-parquet";
import type { WalSegmentRetention } from "@polymarket-bot/storage-parquet";

import { loadResearchWorkerConfig } from "./config.js";
import type { ResearchWorkerConfig } from "./config.js";
import { loadIncidentWindows } from "./incident-windows.js";
import { abortableSleep, runResearchWorker } from "./worker.js";

function buildRetention(
  config: ResearchWorkerConfig,
  objectStore: ReturnType<typeof fileSystemObjectStore>,
): WalSegmentRetention {
  if (config.retention === "retain") {
    return retainAllWalSegments();
  }
  return deleteAfterVerifiedUploadRetention({
    walDirectoryPath: config.walDirectoryPath,
    objectStore,
  });
}

/** Start the worker. Resolves when the loop stops. */
export async function main(): Promise<number> {
  const config = loadResearchWorkerConfig();
  const objectStore = fileSystemObjectStore(config.objectStoreRoot);
  await ensureDirectory(config.objectStoreRoot);

  const incidentWindows = await loadIncidentWindows(config.incidentWindowsPath);

  const controller = new AbortController();
  const stop = (signal: NodeJS.Signals): void => {
    // The loop finishes the cycle in flight and then exits: aborting between an
    // upload and its manifest write is exactly what ADR-004 §5's ordering
    // avoids, and a second signal is the operator's escalation path.
    console.error(
      JSON.stringify({ event: "shutdown-requested", signal, note: "finishing current cycle" }),
    );
    controller.abort();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  console.error(
    JSON.stringify({
      event: "research-worker-started",
      walDirectoryPath: config.walDirectoryPath,
      objectStoreRoot: config.objectStoreRoot,
      retention: config.retention,
      intervalMs: config.intervalMs,
      incidentWindows: incidentWindows.length,
      runOnce: config.runOnce,
    }),
  );

  const outcome = await runResearchWorker(
    {
      config,
      objectStore,
      fileSystem: nodeCompactionFileSystem(),
      clock: systemCompactionClock(),
      retention: buildRetention(config, objectStore),
      incidentWindows,
      sleep: abortableSleep,
      report: (line) => {
        console.log(line);
      },
    },
    controller.signal,
  );

  console.error(
    JSON.stringify({ event: "research-worker-stopped", ...outcome.metrics, cycles: outcome.cycles }),
  );

  // A process that only ever failed exits non-zero, so a supervisor notices.
  return outcome.metrics.cyclesSucceeded === 0 && outcome.metrics.cyclesFailed > 0 ? 1 : 0;
}

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;

if (isEntryPoint) {
  // `storage` (STORAGE-1): one storage cycle — research tier, pins, and the
  // raw-WAL expiry plan, dry-run unless explicitly executed. Loaded only when
  // asked for; with no command, the worker is the WP-130 compaction loop.
  const storage = process.argv[2] === "storage";
  const run = storage ? import("./storage-main.js").then(async (module) => await module.storageMain()) : main();
  run
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          event: storage ? "storage-cycle-fatal" : "research-worker-fatal",
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
      process.exitCode = 1;
    });
}
