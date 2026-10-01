/**
 * The sealed WAL in dispatch order (`STORAGE-1`; ADR-028 Decisions 2.3 and
 * 3.4): what the classifier needs to tell whether a trader has processed a
 * window, and where a decision's source event lies.
 *
 * ## Why dispatch order, not receipt instants
 *
 * Receipt instants are gateway stamps, and they "may repeat or step
 * backwards" (ADR-026 Context 5; ADR-028 Decision 2.1). So "the trader's
 * newest durable decision is stamped after the window's end" does not mean the
 * trader has processed every frame stamped inside the window: a frame later in
 * dispatch order can carry an earlier stamp. Dispatch order is the
 * `(gatewayEpoch, ingestSeq)` order the gateway assigns, which the WAL records
 * and the trader consumes in. This index states, per epoch and in segment
 * order, each sealed segment's ingest range and its receipt span.
 *
 * ## What is verified and what is not
 *
 * A segment's span and ingest range come from its **verified** research-tier
 * manifest entry when it has one. A segment without one (not yet extracted, or
 * refused) is still listed — it can hold a window — with the ingest range its
 * sidecar states and a receipt envelope widened by
 * {@link UNVERIFIED_ENVELOPE_MARGIN_MS}. Unverified facts are only ever used
 * to HOLD: they can add a requirement, never remove one.
 *
 * ## The residual
 *
 * Frames in the open (unsealed) segment are not visible. A window is held
 * until the sealed WAL has moved past it, so an unsealed frame can affect a
 * classified window only if it is stamped back across that whole distance
 * (the gateway seals a segment at least every 15 minutes, `maxSegmentAgeMs`).
 */

import type { ObjectStore, ResearchSourceSegment, VerifiedResearchTierDataset } from "@polymarket-bot/storage-parquet";
import { compareUnsignedIntegerStrings } from "@polymarket-bot/storage-parquet";

import { readResearchPointer } from "../research-tier/extract.js";
import type { InventoriedSegment, WalInventory } from "../research-tier/inventory.js";
import { epochMsOf } from "../research-tier/sampler.js";

/** How far an unverified segment's frames are assumed to reach beyond what its sidecar states. */
export const UNVERIFIED_ENVELOPE_MARGIN_MS = 60 * 60 * 1000;

/** Close reasons after which the writer writes nothing more in the epoch. */
const EPOCH_ENDING_CLOSE_REASONS: ReadonlySet<string> = new Set(["shutdown", "recovery", "write-fault"]);

export type Span = { readonly fromMs: number; readonly toMs: number };

/** One sealed segment, in dispatch order. */
export type IndexedSegment = {
  readonly segment: InventoriedSegment;
  /** True when the facts below come from the verified research-tier manifest. */
  readonly verified: boolean;
  /** Whether the extractor refused it (it can never be extracted, pinned or expired). */
  readonly refused: boolean;
  readonly firstIngestSeq: string | null;
  readonly lastIngestSeq: string | null;
  /** Verified: its frames' receipt span (`null` when it has no frame). Unverified: a conservative envelope. */
  readonly span: Span | null;
};

export type WalIndex = {
  /** Every sealed segment by epoch, each epoch in segment order. */
  readonly byEpoch: ReadonlyMap<string, readonly IndexedSegment[]>;
  /** Sealed segments whose sidecar could not be read: their epoch and frames are unknown. */
  readonly unreadable: number;
};

/** The verified research-tier entry of a segment, or `null` (fail closed on any doubt). */
export async function verifiedEntryOf(
  objectStore: ObjectStore,
  segment: InventoriedSegment,
  verifiedResearch: (manifestObjectKey: string) => Promise<VerifiedResearchTierDataset | Error>,
): Promise<ResearchSourceSegment | null> {
  let pointer;
  try {
    pointer = await readResearchPointer(objectStore, segment.gatewayEpoch, segment.segmentId);
  } catch {
    return null;
  }
  if (pointer === null) return null;
  const research = await verifiedResearch(pointer.manifestObjectKey);
  if (research instanceof Error || research.manifestSha256 !== pointer.manifestSha256) return null;
  const entry = research.manifest.sourceSegments.find((source) => source.segmentId === segment.segmentId);
  if (
    entry === undefined ||
    entry.gatewayEpoch !== segment.gatewayEpoch ||
    entry.segmentSha256 !== pointer.segmentSha256 ||
    entry.segmentFileSha256 !== pointer.segmentFileSha256
  ) {
    return null;
  }
  return entry;
}

function envelopeOf(segment: InventoriedSegment): Span {
  const instants = [segment.createdAt, segment.closedAt, segment.firstReceivedAt, segment.lastReceivedAt]
    .filter((value): value is string => value !== null)
    .map((value) => epochMsOf(value));
  return {
    fromMs: Math.min(...instants) - UNVERIFIED_ENVELOPE_MARGIN_MS,
    toMs: Math.max(...instants) + UNVERIFIED_ENVELOPE_MARGIN_MS,
  };
}

/** Build the index from the inventory and the verified research tier. */
export async function buildWalIndex(input: {
  readonly objectStore: ObjectStore;
  readonly inventory: WalInventory;
  readonly refusedSegmentIds: ReadonlySet<string>;
  readonly verifiedResearch: (manifestObjectKey: string) => Promise<VerifiedResearchTierDataset | Error>;
}): Promise<WalIndex> {
  const byEpoch = new Map<string, IndexedSegment[]>();
  for (const [epoch, segments] of input.inventory.byEpoch) {
    const indexed: IndexedSegment[] = [];
    for (const segment of segments) {
      const entry = await verifiedEntryOf(input.objectStore, segment, input.verifiedResearch);
      if (entry !== null) {
        indexed.push({
          segment,
          verified: true,
          refused: false,
          firstIngestSeq: entry.firstIngestSeq,
          lastIngestSeq: entry.lastIngestSeq,
          span:
            entry.minReceivedAt === null || entry.maxReceivedAt === null
              ? null
              : { fromMs: epochMsOf(entry.minReceivedAt), toMs: epochMsOf(entry.maxReceivedAt) },
        });
      } else {
        indexed.push({
          segment,
          verified: false,
          refused: input.refusedSegmentIds.has(segment.segmentId),
          firstIngestSeq: segment.firstIngestSeq,
          lastIngestSeq: segment.lastIngestSeq,
          span: envelopeOf(segment),
        });
      }
    }
    byEpoch.set(epoch, indexed);
  }
  return { byEpoch, unreadable: input.inventory.unreadable.length };
}

/** A cache of verified research-tier datasets, one verification per manifest. */
export function cachedResearchVerifier(
  verify: (manifestObjectKey: string) => Promise<VerifiedResearchTierDataset>,
): (manifestObjectKey: string) => Promise<VerifiedResearchTierDataset | Error> {
  const cache = new Map<string, Promise<VerifiedResearchTierDataset | Error>>();
  return (key) => {
    let cached = cache.get(key);
    if (cached === undefined) {
      cached = verify(key).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
      cache.set(key, cached);
    }
    return cached;
  };
}

function overlapsSpan(left: Span, right: Span): boolean {
  return left.fromMs <= right.toMs && right.fromMs <= left.toMs;
}

/**
 * How far in one epoch a responsible trader must have durably processed:
 *
 * - `past-segment`: past every frame of the first sealed segment after the
 *   window's last overlapping segment — its durable frontier in the epoch must
 *   reach `ingestSeq` (that segment's last). Every frame dispatched before it
 *   is then processed, whatever it is stamped.
 * - `past-epoch-end`: the epoch ended (its newest segment was sealed by a
 *   shutdown, a recovery or a write fault) inside the window's range; the
 *   frontier must pass `ingestSeq` (the epoch's last frame).
 *
 * Either is also met when the trader moved on to a later epoch in the same
 * run (`DispatchFrontier.completedEpochs`).
 */
export type DispatchRequirement = {
  readonly gatewayEpoch: string;
  readonly kind: "past-segment" | "past-epoch-end";
  readonly ingestSeq: string;
};

/**
 * What a trader must have durably processed before a window whose frames may
 * be stamped inside `range` can be classified; or why it cannot be yet.
 */
export function dispatchRequirements(
  index: WalIndex,
  range: Span,
): { readonly ok: true; readonly requirements: readonly DispatchRequirement[] } | { readonly ok: false; readonly reason: string } {
  if (index.unreadable > 0) {
    return { ok: false, reason: `${String(index.unreadable)} sealed segment(s) have an unreadable sidecar, so their frames' place is unknown` };
  }
  // The sealed WAL must have moved past the range: a verified frame stamped after it.
  const sealedPast = [...index.byEpoch.values()].some((segments) =>
    segments.some((entry) => entry.verified && entry.span !== null && entry.span.toMs > range.toMs),
  );
  if (!sealedPast) return { ok: false, reason: "the sealed, verified WAL has not yet moved past the window's range" };

  const requirements: DispatchRequirement[] = [];
  for (const [epoch, segments] of index.byEpoch) {
    let lastOverlapping = -1;
    segments.forEach((entry, position) => {
      if (entry.span !== null && overlapsSpan(entry.span, range)) lastOverlapping = position;
    });
    if (lastOverlapping < 0) continue;
    const later = segments.slice(lastOverlapping + 1).find((entry) => entry.lastIngestSeq !== null);
    if (later !== undefined && later.lastIngestSeq !== null) {
      requirements.push({ gatewayEpoch: epoch, kind: "past-segment", ingestSeq: later.lastIngestSeq });
      continue;
    }
    const newest = segments[segments.length - 1];
    const lastSeq = [...segments].reverse().find((entry) => entry.lastIngestSeq !== null)?.lastIngestSeq ?? null;
    if (newest !== undefined && EPOCH_ENDING_CLOSE_REASONS.has(newest.segment.closeReason) && lastSeq !== null) {
      requirements.push({ gatewayEpoch: epoch, kind: "past-epoch-end", ingestSeq: lastSeq });
      continue;
    }
    return {
      ok: false,
      reason: `epoch ${epoch} has not sealed a segment after the window's range`,
    };
  }
  return { ok: true, requirements };
}

/** One responsible instance's durable dispatch-order progress. */
export type DispatchFrontier = {
  /** Per gateway epoch, the largest `ingestSeq` of the instance's durable decisions. */
  readonly byEpoch: ReadonlyMap<string, string>;
  /** Epochs the instance moved past within a run: a later decision of the same run is in another epoch. */
  readonly completedEpochs: ReadonlySet<string>;
};

/** Whether one frontier meets one requirement. */
export function meetsRequirement(frontier: DispatchFrontier, requirement: DispatchRequirement): boolean {
  if (frontier.completedEpochs.has(requirement.gatewayEpoch)) return true;
  const reached = frontier.byEpoch.get(requirement.gatewayEpoch);
  if (reached === undefined) return false;
  const order = compareUnsignedIntegerStrings(reached, requirement.ingestSeq);
  return requirement.kind === "past-segment" ? order >= 0 : order > 0;
}

/** Where a source event `(gatewayEpoch, ingestSeq)` lies in the sealed WAL. */
export type SourceLocation =
  | { readonly status: "located"; readonly segmentId: string; readonly span: Span }
  /** It may still be sealed or verified later: the window must wait. */
  | { readonly status: "pending"; readonly reason: string }
  /** Its segment is gone or can never be pinned: the trace stays incomplete, and the pin's segments are kept. */
  | { readonly status: "lost"; readonly reason: string };

/**
 * Locate a source event by its dispatch identity. A decision's
 * `(gatewayEpoch, ingestSeq)` is the identity of the event it consumed, which
 * the gateway dispatched right after the raw frame it came from; so it lies in
 * the segment holding the nearest raw frame at or before it — the last sealed
 * segment (in segment order) whose first `ingestSeq` is at or before it.
 */
export function locateSourceEvent(index: WalIndex, gatewayEpoch: string, ingestSeq: string): SourceLocation {
  const segments = index.byEpoch.get(gatewayEpoch) ?? [];
  if (segments.length === 0) return { status: "pending", reason: `no sealed segment of epoch ${gatewayEpoch} is on disk` };
  let holderPosition = -1;
  segments.forEach((entry, position) => {
    if (entry.firstIngestSeq !== null && compareUnsignedIntegerStrings(entry.firstIngestSeq, ingestSeq) <= 0) {
      holderPosition = position;
    }
  });
  if (holderPosition < 0) return { status: "lost", reason: "it precedes every sealed segment of its epoch on disk" };
  const holder = segments[holderPosition] as IndexedSegment;
  if (holder.lastIngestSeq !== null && compareUnsignedIntegerStrings(ingestSeq, holder.lastIngestSeq) > 0) {
    // After the holder's last frame: either an event dispatched right after
    // it, or a frame of a later segment that is not on disk.
    const next = segments[holderPosition + 1];
    if (next === undefined) {
      if (!EPOCH_ENDING_CLOSE_REASONS.has(holder.segment.closeReason)) {
        return { status: "pending", reason: "it may lie in a segment that is not sealed yet" };
      }
    } else if (next.segment.segmentIndex !== holder.segment.segmentIndex + 1) {
      return { status: "lost", reason: "the segment that held it is no longer on disk" };
    }
  }
  if (!holder.verified) {
    return holder.refused
      ? { status: "lost", reason: `its segment ${holder.segment.segmentId} failed verification and can never be pinned` }
      : { status: "pending", reason: `its segment ${holder.segment.segmentId} is not extracted yet` };
  }
  if (holder.span === null) return { status: "lost", reason: "its segment holds no frame" };
  return { status: "located", segmentId: holder.segment.segmentId, span: holder.span };
}
