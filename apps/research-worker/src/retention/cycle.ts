/**
 * One storage cycle: extract, classify, pin, plan, and — only when asked —
 * expire (`STORAGE-1`; ADR-028, ADR-029).
 *
 * 0. **Clock**: the wall clock is checked against the time since boot, and
 *    any unexplained forward step is subtracted (`clock-guard.ts`), so a
 *    clock that jumps ahead cannot shorten the retention.
 * 1. **Inventory** the sealed segments under the WAL root.
 * 2. **Extract** every unextracted sealed segment into the verified research
 *    tier (`extract.ts`).
 * 3. **Classify** every registered window (`classify.ts`), reading the
 *    trader's durable rows read-only, against the sealed WAL in dispatch
 *    order (`wal-index.ts`); a source event whose segment is gone is
 *    resolved through the window's own verified pin (`ownPinSources`).
 * 4. **Pin** every classified window with evidence, and every operator pin
 *    (`pins.ts`), once the WAL has moved past its range. A window whose
 *    existing pin already fulfils it is bound to that pin, not re-pinned. No
 *    window pin is extracted while the pin catalog does not read in full: the
 *    binding could not see the pin it should bind to.
 * 4b. **Hold**: make every hold the classifications show durable, and release
 *    the holds of every window this cycle settles (`evidence-holds.ts`).
 * 5. **Plan**: decide every sealed segment, with every reason it is kept
 *    (`plan.ts`), against the pins this cycle derives AND every pin already
 *    extracted into the store, and against the durable holds.
 * 6. **Expire**, only in `execute` mode: make the plan durable, then — under
 *    the operator-pin lock — re-decide, prove, re-read the operator's pins and
 *    delete one segment at a time, then write the receipt (`execute.ts`). The
 *    default mode is `dry-run`, which deletes nothing and writes no plan.
 * 7. **Measure**: disk, WAL capacity, pin budget, expiry lag and the clock
 *    (`metrics.ts`).
 */

import type {
  CompactionClock,
  CompactionFileSystem,
  ExpiredSegmentDeletion,
  ObjectStore,
} from "@polymarket-bot/storage-parquet";
import { RetentionGuardError, verifyResearchTierDataset } from "@polymarket-bot/storage-parquet";

import type { ExtractionResult, ResearchPointer } from "../research-tier/extract.js";
import { extractResearchTier, readResearchPointer } from "../research-tier/extract.js";
import { inventoryWalRoot } from "../research-tier/inventory.js";
import type { WalInventory } from "../research-tier/inventory.js";
import { epochMsOf } from "../research-tier/sampler.js";
import type { IntentEvidence, TraderEvidenceSource, WindowClassification } from "./classify.js";
import { classifyWindow } from "./classify.js";
import type { BootClock, ClockAssessment } from "./clock-guard.js";
import { DEFAULT_CLOCK_STEP_TOLERANCE_MS, assessClock, guardedClock } from "./clock-guard.js";
import type { ExpiryPlanEntry, ExpiryRunResult } from "./execute.js";
import {
  buildExpiryPlan,
  executeExpiryPlan,
  expiryReceiptKey,
  listExpiryPlanIds,
  newExpiryPlanId,
  readExpiryPlanEntries,
} from "./execute.js";
import type { StorageMetrics } from "./metrics.js";
import { diskMetrics, storageMetrics } from "./metrics.js";
import type { OperatorPinLock } from "./operator-pin-lock.js";
import { noOperatorPinLock } from "./operator-pin-lock.js";
import type { EvidenceHoldState } from "./evidence-holds.js";
import { persistEvidenceHolds, readEvidenceHolds, rememberEvidence, sameEvidenceHolds, settledWindowIds } from "./evidence-holds.js";
import type { ExtractedPins, PinOutcome, PinRecord, PinSpec } from "./pins.js";
import { bindWindowPins, extractPin, overlaps, ownPinSources, pinSpecs, readExtractedPins, readPinRecord } from "./pins.js";
import type { SegmentDecision } from "./plan.js";
import { planExpiry } from "./plan.js";
import type { WalIndex } from "./wal-index.js";
import { buildWalIndex, cachedResearchVerifier } from "./wal-index.js";
import type { MarketWindow, OperatorPin } from "./windows.js";

/** `dry-run` deletes nothing and writes no plan. It is the default everywhere. */
export type ExpiryMode = "dry-run" | "execute";

export type StorageSettings = {
  /** ADR-028 Decision 2.1: 72 h. */
  readonly retentionMs: number;
  /** The reference lead-in before a pinned range (about 15 min; LEAN-1 §4). */
  readonly leadInMs: number;
  /** How long after its end a window's market can still produce evidence (`classify.ts`). */
  readonly durabilityGraceMs: number;
  readonly pinBudgetBytesPerDay: number;
  readonly expiryStuckAfterMs: number;
  /** The gateway's `maxTotalBytes`, when the operator states it. */
  readonly walMaxTotalBytes: number | null;
  readonly maxSegmentsPerDataset: number;
  /** How long sealed segments may wait to be extracted together (`extract.ts`). */
  readonly extractionBatchDelayMs: number;
  /** Clock movement between cycles below which nothing is a step (`clock-guard.ts`). */
  readonly clockStepToleranceMs?: number;
};

export type StorageCycleDependencies = {
  readonly walRootPath: string;
  readonly objectStore: ObjectStore;
  readonly fileSystem: CompactionFileSystem;
  readonly clock: CompactionClock;
  readonly evidence: TraderEvidenceSource;
  /** Read fresh at the start of the cycle, again right before each deletion, and once more right before each unlink. */
  readonly loadWindows: () => Promise<readonly MarketWindow[]>;
  readonly loadOperatorPins: () => Promise<readonly OperatorPin[]>;
  readonly settings: StorageSettings;
  readonly mode: ExpiryMode;
  /** Required in `execute` mode; never consulted in `dry-run`. */
  readonly deletion: ExpiredSegmentDeletion | null;
  /** Where durable expiry plans and the clock guard's state live. Required in `execute` mode. */
  readonly stateDirectory: string | null;
  /** The time since boot, for the clock guard. Required in `execute` mode. */
  readonly bootClock?: BootClock | null;
  /** Serializes operator-pin publication with each deletion (`operator-pin-lock.ts`). */
  readonly operatorPinLock?: OperatorPinLock;
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
  clock: CompactionClock,
  wal: WalIndex,
  pinnedSource: (window: MarketWindow, event: IntentEvidence) => boolean,
): Promise<ReadonlyMap<string, WindowClassification>> {
  const classifications = new Map<string, WindowClassification>();
  for (const window of windows) {
    try {
      classifications.set(
        window.windowId,
        await classifyWindow(window, {
          nowMs: clock.nowMs(),
          leadInMs: dependencies.settings.leadInMs,
          durabilityGraceMs: dependencies.settings.durabilityGraceMs,
          evidence: dependencies.evidence,
          wal,
          pinnedSource,
        }),
      );
    } catch (error) {
      // Anything else that fails leaves the window unclassified, and what it
      // holds unknown: fail closed, as for a read failure (`evidence-holds.ts`).
      const detail = error instanceof Error ? error.message : String(error);
      classifications.set(window.windowId, {
        windowId: window.windowId,
        state: "unclassified",
        reason: `the trader's rows could not be read: ${detail}`,
        holdRanges: [],
        evidenceUnreadable: detail,
      });
    }
  }
  return classifications;
}

/** Registered trader windows' ids: the windows whose own pins can resolve a source event. */
function traderWindowIds(windows: readonly MarketWindow[]): ReadonlySet<string> {
  return new Set(windows.filter((window) => window.responsibility.kind === "trader").map((window) => window.windowId));
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
      // An unreadable pointer is no pointer: that segment is refused, never pinned or expired.
      const pointer = await readResearchPointer(objectStore, segment.gatewayEpoch, segment.segmentId).catch(() => null);
      if (pointer !== null) pointers.set(segment.segmentId, pointer);
    }
  }
  return pointers;
}

/**
 * Per epoch, the bytes the WAL writer has counted: sealed on disk plus those
 * this worker expired. A durable plan that does not read is counted in
 * `unreadablePlans` (the capacity figure may then be low), never ignored.
 */
async function epochWrittenBytes(
  inventory: WalInventory,
  stateDirectory: string | null,
): Promise<{ counted: Map<string, number>; unreadablePlans: number }> {
  const counted = new Map<string, number>();
  let unreadablePlans = 0;
  const onDisk = new Set<string>();
  for (const [epoch, segments] of inventory.byEpoch) {
    counted.set(epoch, segments.reduce((sum, segment) => sum + segment.byteSize, 0));
    for (const segment of segments) onDisk.add(segment.segmentId);
  }
  if (stateDirectory === null) return { counted, unreadablePlans };
  const expired = new Map<string, { gatewayEpoch: string; byteSize: number }>();
  for (const planId of await listExpiryPlanIds(stateDirectory)) {
    let entries;
    try {
      entries = await readExpiryPlanEntries(stateDirectory, planId);
    } catch {
      unreadablePlans += 1;
      continue;
    }
    // Every planned entry no longer on disk: an over-count at worst (a planned
    // segment that was kept is still on disk, and so is not counted twice).
    for (const entry of entries) {
      if (!onDisk.has(entry.segmentId)) expired.set(entry.segmentId, entry);
    }
  }
  for (const entry of expired.values()) {
    if (!counted.has(entry.gatewayEpoch)) continue; // an epoch gone from disk is not the writer's
    counted.set(entry.gatewayEpoch, (counted.get(entry.gatewayEpoch) ?? 0) + entry.byteSize);
  }
  return { counted, unreadablePlans };
}

/** Run one storage cycle. In `dry-run` (the default), nothing is deleted. */
export async function runStorageCycle(dependencies: StorageCycleDependencies): Promise<StorageCycleReport> {
  const { objectStore, fileSystem, settings } = dependencies;
  if (
    dependencies.mode === "execute" &&
    (dependencies.deletion === null ||
      dependencies.stateDirectory === null ||
      dependencies.bootClock === undefined ||
      dependencies.bootClock === null)
  ) {
    throw new Error("execute mode needs a deletion capability, a state directory and a boot clock; nothing was done");
  }

  // -- 0. The clock: a forward step is subtracted, never trusted. -----------
  const toleranceMs = settings.clockStepToleranceMs ?? DEFAULT_CLOCK_STEP_TOLERANCE_MS;
  const clockAssessment: ClockAssessment = await assessClock({
    stateDirectory: dependencies.stateDirectory,
    wallMs: dependencies.clock.nowMs(),
    bootClock: dependencies.bootClock ?? null,
    toleranceMs,
  });
  const clock = guardedClock(dependencies.clock, clockAssessment.skewMs, toleranceMs);

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
  const refusedSegmentIds = new Set([
    ...extraction.refused.map((entry) => entry.segmentId),
    ...inventory.unreadable.map((entry) => entry.segmentId),
  ]);
  const verifiedResearch = cachedResearchVerifier((key) => verifyResearchTierDataset(objectStore, key));
  const wal = await buildWalIndex({ objectStore, inventory, refusedSegmentIds, verifiedResearch });

  // -- 3. Classify. ---------------------------------------------------------
  const windows = await dependencies.loadWindows();
  const operatorPins = await dependencies.loadOperatorPins();
  // Every pin already in the store: to resolve a source event through the
  // window's own pin, and to bind a window to the pin that fulfils it.
  const catalog = await readExtractedPins(objectStore);
  const classifications = await classifyAll(
    windows,
    dependencies,
    clock,
    wal,
    await ownPinSources(objectStore, catalog.records, traderWindowIds(windows)),
  );

  // -- 4. Pin. ----------------------------------------------------------------
  // A window whose existing pin fulfils it is bound to that pin.
  const specs = bindWindowPins(pinSpecs([...classifications.values()], operatorPins), catalog.records);
  const allSegments = [...inventory.byEpoch.values()].flat();
  const pins: PinOutcome[] = [];
  const pinFailures: { pinId: string; detail: string }[] = [];
  for (const spec of specs) {
    if (spec.origin === "window" && catalog.unreadable.length > 0) {
      // The binding could not see every pin: a window pin extracted now could
      // be a narrower, permanent duplicate of one it should be bound to. The
      // plan keeps every segment meanwhile (`pin-record-unreadable`).
      pins.push({
        pinId: spec.pinId,
        status: "waiting",
        reason: `the pin catalog did not read in full (${catalog.unreadable.map((entry) => entry.pinId).join(", ")}); no window pin is extracted until it does`,
      });
      continue;
    }
    try {
      pins.push(
        await extractPin(spec, {
          objectStore,
          fileSystem,
          clock,
          segments: allSegments,
          pointers,
          refusedSegmentIds,
          wal,
        }),
      );
    } catch (error) {
      pinFailures.push({ pinId: spec.pinId, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  // -- 4b. Hold: what the classifications show is durable before any plan, and
  // a window this cycle settles releases its holds. A dry run reads the holds
  // but never writes them: it deletes nothing, and must not race the timer's
  // read-modify-write of the file. ---------------------------------------------
  const previousHolds = await readEvidenceHolds(dependencies.stateDirectory);
  const rememberedHolds = rememberEvidence({
    state: previousHolds,
    classifications: classifications.values(),
    settled: settledWindowIds({ classifications: classifications.values(), specs, outcomes: pins, state: previousHolds }),
    registeredWindowIds: new Set(windows.map((window) => window.windowId)),
  });
  let holds: EvidenceHoldState =
    dependencies.mode === "execute" ? await persistEvidenceHolds(dependencies.stateDirectory, rememberedHolds) : rememberedHolds;

  // -- 5. Plan. ---------------------------------------------------------------
  const pinRecords = await readPinRecords(objectStore, specs);
  // Every pin in the store, this cycle's new ones included.
  const extractedPins: ExtractedPins = await readExtractedPins(objectStore);
  const decisions = await planExpiry({
    nowMs: clock.nowMs(),
    retentionMs: settings.retentionMs,
    leadInMs: settings.leadInMs,
    durabilityGraceMs: settings.durabilityGraceMs,
    inventory,
    objectStore,
    windows,
    classifications,
    operatorPins,
    pinSpecs: specs,
    pinRecords,
    extractedPins,
    evidenceHolds: holds,
    verifiedResearch,
  });

  // -- 6. Expire, only when asked. -------------------------------------------
  let expiry: ExpiryRunResult | null = null;
  const plan = buildExpiryPlan({
    planId: newExpiryPlanId(clock.nowMs()),
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
      lock: dependencies.operatorPinLock ?? noOperatorPinLock(),
      // Re-decide the one segment from fresh windows, operator pins and
      // classifications, right before its deletion.
      recheck: async (entry) => {
        const freshWindows = await dependencies.loadWindows();
        const freshOperatorPins = await dependencies.loadOperatorPins();
        const freshPins = await readExtractedPins(objectStore);
        const freshClassifications = await classifyAll(
          freshWindows,
          dependencies,
          clock,
          wal,
          await ownPinSources(objectStore, freshPins.records, traderWindowIds(freshWindows)),
        );
        // What the fresh rows show is durable before this deletion (a recheck
        // settles nothing: it extracts no pin).
        const freshHolds = rememberEvidence({
          state: holds,
          classifications: freshClassifications.values(),
          settled: null,
          registeredWindowIds: new Set(freshWindows.map((window) => window.windowId)),
        });
        if (!sameEvidenceHolds(freshHolds, holds)) holds = await persistEvidenceHolds(dependencies.stateDirectory, freshHolds);
        const freshSpecs = bindWindowPins(pinSpecs([...freshClassifications.values()], freshOperatorPins), freshPins.records);
        const segment = allSegments.find((candidate) => candidate.segmentId === entry.request.segmentId);
        if (segment === undefined) return ["the segment is no longer in the inventory"];
        const [fresh] = await planExpiry({
          nowMs: clock.nowMs(),
          retentionMs: settings.retentionMs,
          leadInMs: settings.leadInMs,
          durabilityGraceMs: settings.durabilityGraceMs,
          inventory: { byEpoch: new Map([[segment.gatewayEpoch, [segment]]]), unreadable: [] },
          objectStore,
          windows: freshWindows,
          classifications: freshClassifications,
          operatorPins: freshOperatorPins,
          pinSpecs: freshSpecs,
          pinRecords: await readPinRecords(objectStore, freshSpecs),
          extractedPins: freshPins,
          evidenceHolds: holds,
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
      // The last word, after the proof and immediately before the unlink:
      // the operator's pins, read once more (ADR-028 Decision 2.5).
      finalCheck: async (entry: ExpiryPlanEntry) => {
        const span = { fromMs: epochMsOf(entry.minReceivedAt), toMs: epochMsOf(entry.maxReceivedAt) };
        for (const pin of await dependencies.loadOperatorPins()) {
          if (overlaps(span, { fromMs: pin.fromMs, toMs: pin.toMs })) {
            throw new RetentionGuardError(`operator pin ${pin.pinId} now covers the segment`, {
              segmentId: entry.request.segmentId,
            });
          }
        }
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
  const afterInventory = await inventoryWalRoot(fileSystem, dependencies.walRootPath);
  const written = await epochWrittenBytes(afterInventory, dependencies.stateDirectory);
  // Every pin in the store: the budget counts what was recorded today, whichever window it is for.
  const allPinRecords = new Map<string, PinRecord>();
  for (const record of extractedPins.records) allPinRecords.set(record.pinId, record);
  for (const record of pinRecords.values()) if (record !== null) allPinRecords.set(record.pinId, record);
  const metrics = storageMetrics({
    nowMs: clock.nowMs(),
    decisions,
    walSegmentsUnreadable: inventory.unreadable.length,
    walOrphanSidecars: afterInventory.orphans?.length ?? 0,
    walBytesSealed: [...afterInventory.byEpoch.values()].flat().reduce((sum, segment) => sum + segment.byteSize, 0),
    walEpochWrittenBytes: written.counted,
    expiryPlansUnreadable: written.unreadablePlans,
    disk: await diskMetrics(dependencies.walRootPath),
    walMaxTotalBytes: settings.walMaxTotalBytes,
    pinRecords: [...allPinRecords.values()],
    pinBudgetBytesPerDay: settings.pinBudgetBytesPerDay,
    expiryStuckAfterMs: settings.expiryStuckAfterMs,
    expiryPlansWithoutReceipt: plansWithoutReceipt,
    clock: clockAssessment,
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
