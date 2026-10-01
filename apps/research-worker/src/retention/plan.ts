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
 *    Polymarket token, condition and Gamma market its frames name belongs to a
 *    registered window (an unknown market is unclassified by definition), no
 *    frame could name a market the inventory cannot read, and no registered,
 *    unclassified window could still pin a range overlapping it — its
 *    potential range, or a range its durable rows already show holds chain
 *    evidence (`holdRanges`). The names are read from the VERIFIED
 *    research-tier manifest (`marketIdentities`, taken from every frame),
 *    never from the unverified pointer.
 * 4. **Every pin whose range overlaps it is extracted and verified** (2.4):
 *    every pin this cycle derives AND every pin already extracted into the
 *    store (`readExtractedPins`) — a pin is a durable fact, so a window that
 *    is unclassified this cycle, re-derived with another range or removed
 *    from the registry still has its pin verified and named. Each such pin's
 *    record exists, its manifests verify, every source event it had to hold
 *    lies inside it, and it holds this segment with the same two digests. A
 *    pin record that exists but does not read keeps every segment: its range
 *    is unknown.
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
import type { ExtractedPins, PinRecord } from "./pins.js";
import { overlaps, recordHoldsSourceEvents, verifyPinManifests } from "./pins.js";
import type { PinSpec } from "./pins.js";
import { cachedResearchVerifier } from "./wal-index.js";
import type { MarketWindow, OperatorPin } from "./windows.js";

/** ADR-028 Decision 2.1: 72 hours. */
export const RAW_RETENTION_MS = 72 * 60 * 60 * 1000;

/** One segment's verdict. */
export type SegmentDecision = {
  readonly segment: InventoriedSegment;
  readonly eligible: boolean;
  /** Every reason the segment is kept; empty exactly when it is eligible. */
  readonly reasons: readonly string[];
  /** The oldest and newest receipt instants over its verified frames, when known. */
  readonly minReceivedAt: string | null;
  readonly maxReceivedAt: string | null;
  /** When it reaches the retention age, in epoch ms, when known. */
  readonly ageEligibleAtMs: number | null;
  /**
   * When it is due for expiry, for the lag metric: `ageEligibleAtMs` when
   * known, otherwise its sidecar's `closedAt` plus the retention — so a
   * segment the extract path cannot verify still shows as stuck.
   */
  readonly retentionDueAtMs: number | null;
  /** The deletion request, only when eligible. */
  readonly request: ExpiryDeletionRequest | null;
};

export type ExpiryPlanningInput = {
  readonly nowMs: number;
  readonly retentionMs: number;
  readonly leadInMs: number;
  /** The window range's tail after its end (`classify.ts`, `potentialRange`). */
  readonly durabilityGraceMs: number;
  readonly inventory: WalInventory;
  readonly objectStore: ObjectStore;
  readonly windows: readonly MarketWindow[];
  readonly classifications: ReadonlyMap<string, WindowClassification>;
  readonly operatorPins: readonly OperatorPin[];
  /** Every pin the classified windows and operator pins imply. */
  readonly pinSpecs: readonly PinSpec[];
  /** Pin records by pin id; absent or `null` means not extracted. */
  readonly pinRecords: ReadonlyMap<string, PinRecord | null>;
  /** Every pin already extracted into the store, whatever this cycle derives (`readExtractedPins`). */
  readonly extractedPins: ExtractedPins;
  /** A shared cache of verified research-tier datasets; one is made when absent. */
  readonly verifiedResearch?: (manifestObjectKey: string) => Promise<VerifiedResearchTierDataset | Error>;
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
  const pinCache = new Map<string, Promise<VerifiedPin | Error>>();
  const verifiedResearch =
    input.verifiedResearch ?? cachedResearchVerifier((key) => verifyResearchTierDataset(input.objectStore, key));
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

  // Every pin a segment must be verified against: the window pins this cycle
  // derives (operator pins keep the raw segment itself: guard 5), then every
  // pin record already in the store that no derived spec names.
  type PinObligation = {
    readonly pinId: string;
    readonly fromMs: number;
    readonly toMs: number;
    readonly record: PinRecord | null;
    /** A derived spec's source events, which its record must have been extracted to hold. */
    readonly sourceEvents: PinSpec["sourceEvents"];
  };
  const obligations: PinObligation[] = [];
  const obliged = new Set<string>();
  for (const spec of input.pinSpecs) {
    if (spec.origin === "operator" || obliged.has(spec.pinId)) continue;
    obliged.add(spec.pinId);
    obligations.push({
      pinId: spec.pinId,
      fromMs: spec.fromMs,
      toMs: spec.toMs,
      record: input.pinRecords.get(spec.pinId) ?? null,
      sourceEvents: spec.sourceEvents,
    });
  }
  for (const record of input.extractedPins.records) {
    if (obliged.has(record.pinId)) continue;
    obliged.add(record.pinId);
    obligations.push({ pinId: record.pinId, fromMs: Date.parse(record.from), toMs: Date.parse(record.to), record, sourceEvents: [] });
  }

  const decisions: SegmentDecision[] = [];
  for (const segments of input.inventory.byEpoch.values()) {
    for (const segment of segments) {
      decisions.push(await decide(segment));
    }
  }
  return decisions;

  async function decide(segment: InventoriedSegment): Promise<SegmentDecision> {
    const reasons: string[] = [];
    const closedAtMs = Date.parse(segment.closedAt);
    const keep = (
      minReceivedAt: string | null,
      maxReceivedAt: string | null,
      ageEligibleAtMs: number | null,
    ): SegmentDecision => ({
      segment,
      eligible: false,
      reasons,
      minReceivedAt,
      maxReceivedAt,
      ageEligibleAtMs,
      retentionDueAtMs:
        ageEligibleAtMs ?? (Number.isFinite(closedAtMs) ? closedAtMs + input.retentionMs : null),
      request: null,
    });

    // -- 2. The research tier: written (a pointer) and verified. -------------
    let pointer: ResearchPointer | null;
    try {
      pointer = await readResearchPointer(input.objectStore, segment.gatewayEpoch, segment.segmentId);
    } catch (error) {
      reasons.push(`research-pointer-unreadable: ${error instanceof Error ? error.message : String(error)}`);
      return keep(null, null, null);
    }
    if (pointer === null) {
      reasons.push("not-extracted: no verified research tier names this segment");
      return keep(null, null, null);
    }
    const research = await verifiedResearch(pointer.manifestObjectKey);
    if (research instanceof Error) {
      reasons.push(`research-tier-not-verified: ${research.message}`);
      return keep(null, null, null);
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
      return keep(null, null, null);
    }

    // -- 1. Age, from the maximum receipt instant over every frame. ---------
    const maxReceivedAt = entry.maxReceivedAt;
    const minReceivedAt = entry.minReceivedAt;
    if (maxReceivedAt === null || minReceivedAt === null) {
      reasons.push("no-frames: the segment holds no frame, so it has no age");
      return keep(null, null, null);
    }
    const maxMs = epochMsOf(maxReceivedAt);
    const span = { fromMs: epochMsOf(minReceivedAt), toMs: maxMs };
    const ageEligibleAtMs = maxMs + input.retentionMs;
    if (input.nowMs < ageEligibleAtMs) {
      reasons.push(`younger-than-retention: its newest frame is younger than ${String(input.retentionMs)} ms`);
    }

    // -- 3. Every market it names is registered; every window classified. ---
    // From the VERIFIED manifest entry: the pointer is an index, never proof.
    const named = entry.marketIdentities;
    if (named.unidentifiedFrames > 0) {
      reasons.push(
        `unidentified-market-content: ${String(named.unidentifiedFrames)} frame(s) could carry market content but name no market the inventory can read`,
      );
    }
    for (const token of named.polymarketTokenIds) {
      if (!knownTokens.has(token)) reasons.push(`unknown-market: token ${token} belongs to no registered window`);
    }
    for (const condition of named.conditionIds) {
      if (!knownConditions.has(condition)) {
        reasons.push(`unknown-market: condition ${condition} belongs to no registered window`);
      }
    }
    for (const gammaMarketId of named.gammaMarketIds) {
      if (!knownGammaMarkets.has(gammaMarketId)) {
        reasons.push(`unknown-market: Gamma market ${gammaMarketId} belongs to no registered window`);
      }
    }
    for (const window of input.windows) {
      const classification = input.classifications.get(window.windowId);
      if (classification === undefined || classification.state === "unclassified") {
        const why = classification === undefined ? "" : ` (${classification.reason})`;
        if (overlaps(span, potentialRange(window, input.leadInMs, input.durabilityGraceMs))) {
          reasons.push(`unclassified-window: ${window.windowId}${why}`);
        } else if (classification !== undefined && classification.holdRanges.some((range) => overlaps(span, range))) {
          // Its durable rows already show chain evidence here (a located source
          // event's segment, say): held whatever else is still unknown.
          reasons.push(`unclassified-window: ${window.windowId} holds chain evidence in this segment${why}`);
        }
      }
    }

    // -- 4. Every overlapping pin extracted and verified, holding it. -------
    // The pins this cycle derives, and every pin already in the store.
    for (const unreadable of input.extractedPins.unreadable) {
      reasons.push(`pin-record-unreadable: ${unreadable.pinId}: ${unreadable.detail}`);
    }
    const pins: ExpiryDeletionRequest["pins"][number][] = [];
    for (const obligation of obligations) {
      if (!overlaps(span, { fromMs: obligation.fromMs, toMs: obligation.toMs })) continue;
      const record = obligation.record;
      if (record === null) {
        reasons.push(`pin-not-extracted: ${obligation.pinId}`);
        continue;
      }
      if (record.from !== new Date(obligation.fromMs).toISOString() || record.to !== new Date(obligation.toMs).toISOString()) {
        // Unreachable while pin ids carry their range's digest; kept fail-closed.
        reasons.push(`pin-range-mismatch: ${obligation.pinId}'s record holds a different range than its spec`);
        continue;
      }
      if (!recordHoldsSourceEvents(record, obligation.sourceEvents)) {
        // Unreachable while pin ids carry their source events' digest; kept fail-closed.
        reasons.push(`pin-range-mismatch: ${obligation.pinId}'s record was extracted for other source events than its spec`);
        continue;
      }
      if (!record.sourceEventsInside) {
        reasons.push(`pin-trace-incomplete: ${obligation.pinId} does not hold every source event of its chain`);
        continue;
      }
      const verified = await verifiedPin(record);
      if (verified instanceof Error) {
        reasons.push(`pin-not-verified: ${obligation.pinId}: ${verified.message}`);
        continue;
      }
      const digests = verified.segmentDigests.get(segment.segmentId);
      if (digests === undefined || digests.sha !== entry.segmentSha256 || digests.file !== entry.segmentFileSha256) {
        reasons.push(`pin-does-not-hold-segment: ${obligation.pinId}`);
        continue;
      }
      const dataset = record.datasets.find((candidate) => candidate.segmentIds.includes(segment.segmentId));
      if (dataset === undefined) {
        reasons.push(`pin-does-not-hold-segment: ${obligation.pinId}`);
        continue;
      }
      pins.push({
        pinId: obligation.pinId,
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

    if (reasons.length > 0) return keep(minReceivedAt, maxReceivedAt, ageEligibleAtMs);
    return {
      segment,
      eligible: true,
      reasons: [],
      minReceivedAt,
      maxReceivedAt,
      ageEligibleAtMs,
      retentionDueAtMs: ageEligibleAtMs,
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
