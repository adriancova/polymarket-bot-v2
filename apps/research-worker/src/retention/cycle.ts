/**
 * One storage cycle: extract, classify, pin, plan, and — only when asked —
 * expire (`STORAGE-1`; ADR-028, ADR-029).
 *
 * 1. **Inventory** the sealed segments under the WAL root.
 * 2. **Extract** every unextracted sealed segment into the verified research
 *    tier (`extract.ts`).
 * 3. **Classify** every registered window (`classify.ts`), reading the
 *    trader's durable rows read-only.
 * 4. **Pin** every classified window with evidence, and every operator pin
 *    (`pins.ts`), once the WAL has moved past its range.
 * 5. **Plan**: decide every sealed segment, with every reason it is kept
 *    (`plan.ts`).
 * 6. **Expire**, only in `execute` mode: make the plan durable, then re-decide,
 *    prove and delete one segment at a time, then write the receipt
 *    (`execute.ts`). The default mode is `dry-run`, which deletes nothing and
 *    writes no plan.
 * 7. **Measure**: disk, pin budget and expiry lag (`metrics.ts`).
 */

import type {
  CompactionClock,
  CompactionFileSystem,
  ExpiredSegmentDeletion,
  ObjectStore,
} from "@polymarket-bot/storage-parquet";

import type { ExtractionResult, ResearchPointer } from "../research-tier/extract.js";
import { extractResearchTier, readResearchPointer } from "../research-tier/extract.js";
import { inventoryWalRoot } from "../research-tier/inventory.js";
import type { WalInventory } from "../research-tier/inventory.js";
import type { TraderEvidenceSource, WindowClassification } from "./classify.js";
import { classifyWindow } from "./classify.js";
import type { ExpiryRunResult } from "./execute.js";
import { buildExpiryPlan, executeExpiryPlan, expiryReceiptKey, listExpiryPlanIds } from "./execute.js";
import type { StorageMetrics } from "./metrics.js";
import { diskMetrics, storageMetrics } from "./metrics.js";
import type { PinOutcome, PinRecord, PinSpec } from "./pins.js";
import { extractPin, pinSpecs, readPinRecord } from "./pins.js";
import type { SegmentDecision } from "./plan.js";
import { planExpiry } from "./plan.js";
import type { MarketWindow, OperatorPin } from "./windows.js";

/** `dry-run` deletes nothing and writes no plan. It is the default everywhere. */
export type ExpiryMode = "dry-run" | "execute";

export type StorageSettings = {
  /** ADR-028 Decision 2.1: 72 h. */
  readonly retentionMs: number;
  /** The reference lead-in before a pinned range (about 15 min; LEAN-1 §4). */
  readonly leadInMs: number;
  /** Margin a trader's durable frontier must pass a window's end by. */
  readonly durabilityGraceMs: number;
  readonly pinBudgetBytesPerDay: number;
  readonly expiryStuckAfterMs: number;
  /** The gateway's `maxTotalBytes`, when the operator states it. */
  readonly walMaxTotalBytes: number | null;
  readonly maxSegmentsPerDataset: number;
  /** How long sealed segments may wait to be extracted together (`extract.ts`). */
  readonly extractionBatchDelayMs: number;
};

export type StorageCycleDependencies = {
  readonly walRootPath: string;
  readonly objectStore: ObjectStore;
  readonly fileSystem: CompactionFileSystem;
  readonly clock: CompactionClock;
  readonly evidence: TraderEvidenceSource;
  /** Read fresh at the start of the cycle, and again right before each deletion. */
  readonly loadWindows: () => Promise<readonly MarketWindow[]>;
  readonly loadOperatorPins: () => Promise<readonly OperatorPin[]>;
  readonly settings: StorageSettings;
  readonly mode: ExpiryMode;
  /** Required in `execute` mode; never consulted in `dry-run`. */
  readonly deletion: ExpiredSegmentDeletion | null;
  /** Where durable expiry plans live. Required in `execute` mode. */
  readonly stateDirectory: string | null;
};

export type StorageCycleReport = {
  readonly mode: ExpiryMode;
  readonly extraction: ExtractionResult;
  readonly classifications: readonly WindowClassification[];
  readonly pins: readonly PinOutcome[];
  readonly pinFailures: readonly { readonly pinId: string; readonly detail: string }[];
  readonly decisions: readonly SegmentDecision[];
  readonly expiry: ExpiryRunResult | null;
  readonly metrics: StorageMetrics;
};

async function classifyAll(
  windows: readonly MarketWindow[],
  dependencies: StorageCycleDependencies,
): Promise<ReadonlyMap<string, WindowClassification>> {
  const classifications = new Map<string, WindowClassification>();
  for (const window of windows) {
    try {
      classifications.set(
        window.windowId,
        await classifyWindow(window, {
          nowMs: dependencies.clock.nowMs(),
          leadInMs: dependencies.settings.leadInMs,
          durabilityGraceMs: dependencies.settings.durabilityGraceMs,
          evidence: dependencies.evidence,
        }),
      );
    } catch (error) {
      // An unreachable evidence source leaves the window unclassified: fail closed.
      classifications.set(window.windowId, {
        windowId: window.windowId,
        state: "unclassified",
        reason: `the trader's rows could not be read: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return classifications;
}

async function readPinRecords(
  objectStore: ObjectStore,
  specs: readonly PinSpec[],
): Promise<Map<string, PinRecord | null>> {
  const records = new Map<string, PinRecord | null>();
  for (const spec of specs) {
    try {
      records.set(spec.pinId, await readPinRecord(objectStore, spec.pinId));
    } catch {
      records.set(spec.pinId, null);
    }
  }
  return records;
}

async function pointersOf(objectStore: ObjectStore, inventory: WalInventory): Promise<Map<string, ResearchPointer>> {
  const pointers = new Map<string, ResearchPointer>();
  for (const segments of inventory.byEpoch.values()) {
    for (const segment of segments) {
      const pointer = await readResearchPointer(objectStore, segment.gatewayEpoch, segment.segmentId);
      if (pointer !== null) pointers.set(segment.segmentId, pointer);
    }
  }
  return pointers;
}

/** Run one storage cycle. In `dry-run` (the default), nothing is deleted. */
export async function runStorageCycle(dependencies: StorageCycleDependencies): Promise<StorageCycleReport> {
  const { objectStore, fileSystem, clock, settings } = dependencies;
  if (dependencies.mode === "execute" && (dependencies.deletion === null || dependencies.stateDirectory === null)) {
    throw new Error("execute mode needs a deletion capability and a state directory; nothing was done");
  }

  // -- 1./2. Inventory and extract. ----------------------------------------
  let inventory = await inventoryWalRoot(fileSystem, dependencies.walRootPath);
  const extraction = await extractResearchTier({
    fileSystem,
    objectStore,
    clock,
    byEpoch: inventory.byEpoch,
    maxSegmentsPerDataset: settings.maxSegmentsPerDataset,
    batchDelayMs: settings.extractionBatchDelayMs,
  });
  inventory = await inventoryWalRoot(fileSystem, dependencies.walRootPath);
  const pointers = await pointersOf(objectStore, inventory);

  // -- 3. Classify. ---------------------------------------------------------
  const windows = await dependencies.loadWindows();
  const operatorPins = await dependencies.loadOperatorPins();
  const classifications = await classifyAll(windows, dependencies);

  // -- 4. Pin. ----------------------------------------------------------------
  const specs = pinSpecs([...classifications.values()], operatorPins);
  const allSegments = [...inventory.byEpoch.values()].flat();
  const refusedSegmentIds = new Set([
    ...extraction.refused.map((entry) => entry.segmentId),
    ...inventory.unreadable.map((entry) => entry.segmentId),
  ]);
  const pins: PinOutcome[] = [];
  const pinFailures: { pinId: string; detail: string }[] = [];
  for (const spec of specs) {
    try {
      pins.push(
        await extractPin(spec, {
          objectStore,
          fileSystem,
          clock,
          segments: allSegments,
          pointers,
          refusedSegmentIds,
        }),
      );
    } catch (error) {
      pinFailures.push({ pinId: spec.pinId, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // -- 5. Plan. ---------------------------------------------------------------
  const pinRecords = await readPinRecords(objectStore, specs);
  const decisions = await planExpiry({
    nowMs: clock.nowMs(),
    retentionMs: settings.retentionMs,
    leadInMs: settings.leadInMs,
    inventory,
    objectStore,
    windows,
    classifications,
    operatorPins,
    pinSpecs: specs,
    pinRecords,
  });

  // -- 6. Expire, only when asked. -------------------------------------------
  let expiry: ExpiryRunResult | null = null;
  const plan = buildExpiryPlan({
    planId: `expiry-${new Date(clock.nowMs()).toISOString().replace(/[:.]/gu, "-")}`,
    nowMs: clock.nowMs(),
    retentionMs: settings.retentionMs,
    walRootPath: dependencies.walRootPath,
    decisions,
  });
  if (dependencies.mode === "execute" && plan.entries.length > 0) {
    const deletion = dependencies.deletion as ExpiredSegmentDeletion;
    expiry = await executeExpiryPlan({
      plan,
      stateDirectory: dependencies.stateDirectory as string,
      objectStore,
      deletion,
      clock,
      // Re-decide the one segment from fresh windows, operator pins and
      // classifications, right before its deletion.
      recheck: async (entry) => {
        const freshWindows = await dependencies.loadWindows();
        const freshOperatorPins = await dependencies.loadOperatorPins();
        const freshClassifications = await classifyAll(freshWindows, dependencies);
        const freshSpecs = pinSpecs([...freshClassifications.values()], freshOperatorPins);
        const segment = allSegments.find((candidate) => candidate.segmentId === entry.request.segmentId);
        if (segment === undefined) return ["the segment is no longer in the inventory"];
        const [fresh] = await planExpiry({
          nowMs: clock.nowMs(),
          retentionMs: settings.retentionMs,
          leadInMs: settings.leadInMs,
          inventory: { byEpoch: new Map([[segment.gatewayEpoch, [segment]]]), unreadable: [] },
          objectStore,
          windows: freshWindows,
          classifications: freshClassifications,
          operatorPins: freshOperatorPins,
          pinSpecs: freshSpecs,
          pinRecords: await readPinRecords(objectStore, freshSpecs),
        });
        if (fresh === undefined) return ["the segment could not be re-decided"];
        if (!fresh.eligible) return fresh.reasons;
        // The proof must name the same pins the fresh decision requires.
        const planned = new Set(entry.request.pins.map((pin) => pin.pinId));
        const required = new Set((fresh.request?.pins ?? []).map((pin) => pin.pinId));
        if (planned.size !== required.size || [...required].some((pinId) => !planned.has(pinId))) {
          return ["the set of overlapping pins changed since the plan was made"];
        }
        return [];
      },
    });
  }

  // -- 7. Measure. ------------------------------------------------------------
  let plansWithoutReceipt = 0;
  if (dependencies.stateDirectory !== null) {
    for (const planId of await listExpiryPlanIds(dependencies.stateDirectory)) {
      if ((await objectStore.head(expiryReceiptKey(planId))) === null) plansWithoutReceipt += 1;
    }
  }
  const allPinRecords = [...pinRecords.values()].filter((record): record is PinRecord => record !== null);
  const metrics = storageMetrics({
    nowMs: clock.nowMs(),
    decisions,
    walSegmentsUnreadable: inventory.unreadable.length,
    walBytesSealed: allSegments.reduce((sum, segment) => sum + segment.byteSize, 0),
    disk: await diskMetrics(dependencies.walRootPath),
    walMaxTotalBytes: settings.walMaxTotalBytes,
    pinRecords: allPinRecords,
    pinBudgetBytesPerDay: settings.pinBudgetBytesPerDay,
    expiryStuckAfterMs: settings.expiryStuckAfterMs,
    expiryPlansWithoutReceipt: plansWithoutReceipt,
  });

  return {
    mode: dependencies.mode,
    extraction,
    classifications: [...classifications.values()],
    pins,
    pinFailures,
    decisions,
    expiry,
    metrics,
  };
}
