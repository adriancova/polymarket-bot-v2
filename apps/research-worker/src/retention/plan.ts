/**
 * The expiry decision (ADR-028 Decision 2): which raw WAL segments may be
 * deleted now, and, for every other one, why it is kept.
 *
 * A segment may expire only when **all** of these hold, each checked here
 * from durable state, and each failure recorded as a reason to keep it:
 *
 * 1. **It is at least the retention age old** (72 h) — taken from the newest
 *    `receivedAt` over **all** of its verified frames (Decision 2.1). The
 *    value comes from the verified research-tier manifest, which the
 *    extractor computed as a maximum over every frame, never from the last
 *    frame in dispatch order. A segment with no frame has no such instant and
 *    is kept.
 * 2. **Its research tier is written and verified** (2.2): the dataset its
 *    pointer names re-verifies from the store and lists the segment with the
 *    pointer's two digests.
 * 3. **Every market window that overlaps it is classified** (2.3): every
 *    Polymarket token and condition its frames name belongs to a registered
 *    window (an unknown market is unclassified by definition), and no
 *    registered, unclassified window could still pin a range overlapping it.
 * 4. **Every pin whose range overlaps it is extracted and verified** (2.4):
 *    its record exists, its manifests verify, every source event it had to
 *    hold lies inside it, and it holds this segment with the same two digests.
 * 5. **No operator pin covers it** (2.5).
 *
 * Decisions 2.6 and 2.7 — the bytes are the ones extracted, and the file is
 * checked at deletion time — are the deletion guard's (`verifyExpiryProof`),
 * run on the exact bytes immediately before each unlink.
 *
 * The planner reads only. It never deletes; `execute.ts` does, after the plan
 * is durable.
 */

import type {
  ExpiryDeletionRequest,
  ObjectStore,
  ResearchSourceSegment,
  VerifiedResearchTierDataset,
} from "@polymarket-bot/storage-parquet";
import { verifyResearchTierDataset } from "@polymarket-bot/storage-parquet";

import type { ResearchPointer } from "../research-tier/extract.js";
import { readResearchPointer } from "../research-tier/extract.js";
import type { InventoriedSegment, WalInventory } from "../research-tier/inventory.js";
import { epochMsOf } from "../research-tier/sampler.js";
import type { WindowClassification } from "./classify.js";
import { potentialRange } from "./classify.js";
import type { PinRecord } from "./pins.js";
import { overlaps, verifyPinManifests } from "./pins.js";
import type { PinSpec } from "./pins.js";
import type { MarketWindow, OperatorPin } from "./windows.js";

/** ADR-028 Decision 2.1: 72 hours. */
export const RAW_RETENTION_MS = 72 * 60 * 60 * 1000;

/** One segment's verdict. */
export type SegmentDecision = {
  readonly segment: InventoriedSegment;
  readonly eligible: boolean;
  /** Every reason the segment is kept; empty exactly when it is eligible. */
  readonly reasons: readonly string[];
  /** The newest receipt instant over its verified frames, when known. */
  readonly maxReceivedAt: string | null;
  /** When it reaches the retention age, in epoch ms, when known. */
  readonly ageEligibleAtMs: number | null;
  /** The deletion request, only when eligible. */
  readonly request: ExpiryDeletionRequest | null;
};

export type ExpiryPlanningInput = {
  readonly nowMs: number;
  readonly retentionMs: number;
  readonly leadInMs: number;
  readonly inventory: WalInventory;
  readonly objectStore: ObjectStore;
  readonly windows: readonly MarketWindow[];
  readonly classifications: ReadonlyMap<string, WindowClassification>;
  readonly operatorPins: readonly OperatorPin[];
  /** Every pin the classified windows and operator pins imply. */
  readonly pinSpecs: readonly PinSpec[];
  /** Pin records by pin id; absent or `null` means not extracted. */
  readonly pinRecords: ReadonlyMap<string, PinRecord | null>;
};

type VerifiedPin = { readonly record: PinRecord; readonly segmentDigests: ReadonlyMap<string, { sha: string; file: string }> };

async function loadVerifiedPin(objectStore: ObjectStore, record: PinRecord): Promise<VerifiedPin> {
  const manifests = await verifyPinManifests(objectStore, record);
  const segmentDigests = new Map<string, { sha: string; file: string }>();
  for (const manifest of manifests.values()) {
    for (const entry of manifest.segments) {
      segmentDigests.set(entry.segmentId, { sha: entry.segmentSha256, file: entry.segmentFileSha256 });
    }
  }
  return { record, segmentDigests };
}

/** Decide every sealed segment. */
export async function planExpiry(input: ExpiryPlanningInput): Promise<readonly SegmentDecision[]> {
  const knownTokens = new Set(input.windows.flatMap((window) => window.tokenIds));
  const knownConditions = new Set(input.windows.map((window) => window.conditionId));
  const knownGammaMarkets = new Set(
    input.windows.map((window) => window.gammaMarketId).filter((id): id is string => id !== null),
  );
  const researchCache = new Map<string, Promise<VerifiedResearchTierDataset | Error>>();
  const pinCache = new Map<string, Promise<VerifiedPin | Error>>();

  const verifiedResearch = (key: string): Promise<VerifiedResearchTierDataset | Error> => {
    let cached = researchCache.get(key);
    if (cached === undefined) {
      cached = verifyResearchTierDataset(input.objectStore, key).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      researchCache.set(key, cached);
    }
    return cached;
  };
  const verifiedPin = (record: PinRecord): Promise<VerifiedPin | Error> => {
    let cached = pinCache.get(record.pinId);
    if (cached === undefined) {
      cached = loadVerifiedPin(input.objectStore, record).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      pinCache.set(record.pinId, cached);
    }
    return cached;
  };

  const decisions: SegmentDecision[] = [];
  for (const segments of input.inventory.byEpoch.values()) {
    for (const segment of segments) {
      decisions.push(await decide(segment));
    }
  }
  return decisions;

  async function decide(segment: InventoriedSegment): Promise<SegmentDecision> {
    const reasons: string[] = [];
    const keep = (maxReceivedAt: string | null, ageEligibleAtMs: number | null): SegmentDecision => ({
      segment,
      eligible: false,
      reasons,
      maxReceivedAt,
      ageEligibleAtMs,
      request: null,
    });

    // -- 2. The research tier: written (a pointer) and verified. -------------
    let pointer: ResearchPointer | null;
    try {
      pointer = await readResearchPointer(input.objectStore, segment.gatewayEpoch, segment.segmentId);
    } catch (error) {
      reasons.push(`research-pointer-unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return keep(null, null);
    }
    if (pointer === null) {
      reasons.push("not-extracted: no verified research tier names this segment");
      return keep(null, null);
    }
    const research = await verifiedResearch(pointer.manifestObjectKey);
    if (research instanceof Error) {
      reasons.push(`research-tier-not-verified: ${research.message}`);
      return keep(null, null);
    }
    const entry: ResearchSourceSegment | undefined = research.manifest.sourceSegments.find(
      (source) => source.segmentId === segment.segmentId,
    );
    if (
      entry === undefined ||
      research.manifestSha256 !== pointer.manifestSha256 ||
      entry.segmentSha256 !== pointer.segmentSha256 ||
      entry.segmentFileSha256 !== pointer.segmentFileSha256 ||
      entry.gatewayEpoch !== segment.gatewayEpoch
    ) {
      reasons.push("research-tier-mismatch: the verified research tier does not list this segment as its pointer says");
      return keep(null, null);
    }

    // -- 1. Age, from the maximum receipt instant over every frame. ---------
    const maxReceivedAt = entry.maxReceivedAt;
    const minReceivedAt = entry.minReceivedAt;
    if (maxReceivedAt === null || minReceivedAt === null) {
      reasons.push("no-frames: the segment holds no frame, so it has no age");
      return keep(null, null);
    }
    const maxMs = epochMsOf(maxReceivedAt);
    const span = { fromMs: epochMsOf(minReceivedAt), toMs: maxMs };
    const ageEligibleAtMs = maxMs + input.retentionMs;
    if (input.nowMs < ageEligibleAtMs) {
      reasons.push(`younger-than-retention: its newest frame is younger than ${String(input.retentionMs)} ms`);
    }

    // -- 3. Every market it names is registered; every window classified. ---
    for (const token of pointer.polymarketTokenIds) {
      if (!knownTokens.has(token)) reasons.push(`unknown-market: token ${token} belongs to no registered window`);
    }
    for (const condition of pointer.conditionIds) {
      if (!knownConditions.has(condition)) {
        reasons.push(`unknown-market: condition ${condition} belongs to no registered window`);
      }
    }
    for (const gammaMarketId of pointer.gammaMarketIds) {
      if (!knownGammaMarkets.has(gammaMarketId)) {
        reasons.push(`unknown-market: Gamma market ${gammaMarketId} belongs to no registered window`);
      }
    }
    for (const window of input.windows) {
      const classification = input.classifications.get(window.windowId);
      if (classification === undefined || classification.state === "unclassified") {
        if (overlaps(span, potentialRange(window, input.leadInMs))) {
          reasons.push(
            `unclassified-window: ${window.windowId}${classification === undefined ? "" : ` (${classification.reason})`}`,
          );
        }
      }
    }

    // -- 4. Every overlapping pin extracted and verified, holding it. -------
    const pins: ExpiryDeletionRequest["pins"][number][] = [];
    for (const spec of input.pinSpecs) {
      if (!overlaps(span, { fromMs: spec.fromMs, toMs: spec.toMs })) continue;
      // Operator pins keep the segment itself: guard 5, below.
      if (spec.origin === "operator") continue;
      const record = input.pinRecords.get(spec.pinId) ?? null;
      if (record === null) {
        reasons.push(`pin-not-extracted: ${spec.pinId}`);
        continue;
      }
      if (record.from !== new Date(spec.fromMs).toISOString() || record.to !== new Date(spec.toMs).toISOString()) {
        // Unreachable while pin ids carry their range's digest; kept fail-closed.
        reasons.push(`pin-range-mismatch: ${spec.pinId}'s record holds a different range than its spec`);
        continue;
      }
      if (!record.sourceEventsInside) {
        reasons.push(`pin-trace-incomplete: ${spec.pinId} does not hold every source event of its chain`);
        continue;
      }
      const verified = await verifiedPin(record);
      if (verified instanceof Error) {
        reasons.push(`pin-not-verified: ${spec.pinId}: ${verified.message}`);
        continue;
      }
      const digests = verified.segmentDigests.get(segment.segmentId);
      if (digests === undefined || digests.sha !== entry.segmentSha256 || digests.file !== entry.segmentFileSha256) {
        reasons.push(`pin-does-not-hold-segment: ${spec.pinId}`);
        continue;
      }
      const dataset = record.datasets.find((candidate) => candidate.segmentIds.includes(segment.segmentId));
      if (dataset === undefined) {
        reasons.push(`pin-does-not-hold-segment: ${spec.pinId}`);
        continue;
      }
      pins.push({
        pinId: spec.pinId,
        datasetId: dataset.datasetId,
        manifestObjectKey: dataset.manifestObjectKey,
        manifestSha256: dataset.manifestSha256,
      });
    }
    // -- 5. No operator pin covers it: an operator pin keeps the raw segment.
    for (const pin of input.operatorPins) {
      if (overlaps(span, { fromMs: pin.fromMs, toMs: pin.toMs })) {
        reasons.push(`operator-pin: operator-${pin.pinId}`);
      }
    }

    if (reasons.length > 0) return keep(maxReceivedAt, ageEligibleAtMs);
    return {
      segment,
      eligible: true,
      reasons: [],
      maxReceivedAt,
      ageEligibleAtMs,
      request: {
        segmentId: segment.segmentId,
        gatewayEpoch: segment.gatewayEpoch,
        segmentSha256: entry.segmentSha256,
        segmentFileSha256: entry.segmentFileSha256,
        researchTier: {
          datasetId: research.manifest.datasetId,
          manifestObjectKey: research.manifestObjectKey,
          manifestSha256: research.manifestSha256,
        },
        pins,
      },
    };
  }
}

/** The reason class of a kept segment, for metrics: the text before the colon. */
export function reasonClass(reason: string): string {
  const colon = reason.indexOf(":");
  return colon < 0 ? reason : reason.slice(0, colon);
}
