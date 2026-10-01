/**
 * Pinned windows (ADR-028 Decision 3).
 *
 * A pin is an **exact** copy of a range of raw frames: the whole market window
 * plus the reference feeds over it and a lead-in before it, widened so that
 * every source event of every decision in a fill's chain lies inside it.
 *
 * ## How a pin is stored
 *
 * "As lossless Parquet from the existing compactor, with its own immutable
 * dataset manifest (ADR-017)" (Decision 3.3). A pin is one exact dataset per
 * gateway epoch its range touches — `compactWalDirectory`, unchanged, over the
 * **whole** sealed segments that overlap the range (the compactor refuses a
 * mixed-epoch batch, and a pin needs no cross-epoch order). Whole segments
 * make a pin a superset of its range and let the `WP-130` guard prove, byte
 * for byte, that a deleted segment survives in the pin
 * (`verifyRetentionProof`).
 *
 * A small immutable **pin record** names the pin's datasets. It is written
 * only after every dataset verified, so a record is the statement "this pin
 * is extracted and verified"; the deletion guard still re-verifies the bytes.
 *
 * ## What a pin never does
 *
 * Nothing here deletes, evicts or shrinks a pin. A fill pin lasts forever
 * (`keepUntil: null`); a pin over budget only raises an alarm (`metrics.ts`;
 * Decision 3.6, 3.7). The 30-day lapse of a non-fill pin is recorded as
 * `keepUntil` and is not acted on by this package.
 */

import type {
  CompactionClock,
  CompactionFileSystem,
  DatasetManifest,
  ObjectStore,
} from "@polymarket-bot/storage-parquet";
import {
  DATASET_MANIFEST_OBJECT_NAME,
  compactWalDirectory,
  manifestDigestSidecarKey,
  parseDatasetManifest,
  parseStrictJsonBytes,
  retainAllWalSegments,
  sha256Hex,
} from "@polymarket-bot/storage-parquet";

import type { ResearchPointer } from "../research-tier/extract.js";
import type { InventoriedSegment } from "../research-tier/inventory.js";
import { epochMsOf } from "../research-tier/sampler.js";
import type { IntentEvidence, PinClass, WindowClassification } from "./classify.js";
import type { WalIndex } from "./wal-index.js";
import { locateSourceEvent } from "./wal-index.js";
import type { OperatorPin } from "./windows.js";

/** The object-key root of pins. */
export const PIN_KEY_PREFIX = "pins";

/** The version of {@link PinRecord}. */
export const PIN_RECORD_VERSION = 1;

/** A pin to hold: from a classified window, or from an operator. */
export type PinSpec = {
  readonly pinId: string;
  readonly origin: "window" | "operator";
  readonly pinClass: PinClass | "operator";
  readonly windowId: string | null;
  readonly fromMs: number;
  readonly toMs: number;
  /** `null` is forever (a fill), or until the operator removes it. */
  readonly keepUntilMs: number | null;
  readonly sourceEvents: readonly IntentEvidence[];
  readonly reason: string;
};

/** One exact dataset a pin holds. */
export type PinDataset = {
  readonly gatewayEpoch: string;
  readonly datasetId: string;
  readonly manifestObjectKey: string;
  readonly manifestSha256: string;
  readonly segmentIds: readonly string[];
  readonly objectBytes: number;
};

/** The immutable statement that a pin is extracted and verified. */
export type PinRecord = {
  readonly pinRecordVersion: number;
  readonly pinId: string;
  readonly origin: "window" | "operator";
  readonly pinClass: PinClass | "operator";
  readonly windowId: string | null;
  readonly from: string;
  readonly to: string;
  readonly keepUntil: string | null;
  readonly reason: string;
  readonly datasets: readonly PinDataset[];
  /** Every source event that had to lie inside the pin did (Decision 3.4). */
  readonly sourceEventsInside: boolean;
  readonly sourceEventsOutside: readonly IntentEvidence[];
  readonly createdAt: string;
};

/** The pins implied by the classified windows and the operator's pins. */
export function pinSpecs(
  classifications: readonly WindowClassification[],
  operatorPins: readonly OperatorPin[],
): readonly PinSpec[] {
  const specs: PinSpec[] = [];
  for (const classification of classifications) {
    if (classification.state !== "classified" || classification.pinClass === null) continue;
    if (classification.pinFromMs === null || classification.pinToMs === null) continue;
    specs.push({
      pinId: windowPinId(classification.windowId, classification.pinClass, classification.pinFromMs, classification.pinToMs),
      origin: "window",
      pinClass: classification.pinClass,
      windowId: classification.windowId,
      fromMs: classification.pinFromMs,
      toMs: classification.pinToMs,
      keepUntilMs: classification.keepUntilMs,
      sourceEvents: classification.sourceEvents,
      reason: `window ${classification.windowId} had ${classification.pinClass} evidence`,
    });
  }
  for (const pin of operatorPins) {
    specs.push({
      pinId: `operator-${pin.pinId}`,
      origin: "operator",
      pinClass: "operator",
      windowId: null,
      fromMs: pin.fromMs,
      toMs: pin.toMs,
      keepUntilMs: null,
      sourceEvents: [],
      reason: pin.reason,
    });
  }
  return specs;
}

/**
 * A window pin's id: the window, and a short digest of what the pin holds.
 *
 * A pin record is immutable. Should a window's evidence ever imply a
 * different range or class after its pin was extracted, the new range is a
 * new pin with its own id — extracted beside the old one, which is kept —
 * rather than a stuck expiry or a rewritten record.
 */
export function windowPinId(windowId: string, pinClass: PinClass, fromMs: number, toMs: number): string {
  const digest = sha256Hex(JSON.stringify([pinClass, fromMs, toMs])).slice(0, 12);
  return `window-${windowId}-${digest}`;
}

/** The key of a pin's record. */
export function pinRecordKey(pinId: string): string {
  return `${PIN_KEY_PREFIX}/${pinId}/pin.json`;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u;

/** Parse a pin record's bytes (strict JSON, ADR-017 §3), checking every field the planner relies on. */
export function parsePinRecord(bytes: Uint8Array, key: string): PinRecord {
  const fail = (what: string): never => {
    throw new Error(`pin record ${key} is not one this build reads: ${what}`);
  };
  let value: unknown;
  try {
    value = parseStrictJsonBytes(bytes);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const object = (raw: unknown, what: string): Record<string, unknown> =>
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : fail(`${what} is not an object`);
  const text = (raw: unknown, what: string, pattern?: RegExp): string =>
    typeof raw === "string" && raw.length > 0 && (pattern === undefined || pattern.test(raw)) ? raw : fail(`${what} is malformed`);
  const count = (raw: unknown, what: string): number =>
    typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? raw : fail(`${what} is malformed`);
  const root = object(value, "the record");
  if (root["pinRecordVersion"] !== PIN_RECORD_VERSION) fail("an unknown pinRecordVersion");
  const origin = root["origin"];
  if (origin !== "window" && origin !== "operator") fail("origin is malformed");
  const pinClass = root["pinClass"];
  if (!["fill", "halt", "refusal", "intent", "operator"].includes(String(pinClass))) fail("pinClass is malformed");
  const datasets = Array.isArray(root["datasets"]) ? (root["datasets"] as unknown[]) : fail("datasets is not an array");
  const outside = Array.isArray(root["sourceEventsOutside"]) ? (root["sourceEventsOutside"] as unknown[]) : fail("sourceEventsOutside is not an array");
  if (typeof root["sourceEventsInside"] !== "boolean") fail("sourceEventsInside is not a boolean");
  return {
    pinRecordVersion: PIN_RECORD_VERSION,
    pinId: text(root["pinId"], "pinId"),
    origin: origin as PinRecord["origin"],
    pinClass: pinClass as PinRecord["pinClass"],
    windowId: root["windowId"] === null ? null : text(root["windowId"], "windowId"),
    from: text(root["from"], "from", ISO_INSTANT),
    to: text(root["to"], "to", ISO_INSTANT),
    keepUntil: root["keepUntil"] === null ? null : text(root["keepUntil"], "keepUntil", ISO_INSTANT),
    reason: text(root["reason"], "reason"),
    datasets: datasets.map((raw, index) => {
      const dataset = object(raw, `datasets[${String(index)}]`);
      const segmentIds = Array.isArray(dataset["segmentIds"]) ? (dataset["segmentIds"] as unknown[]) : fail("segmentIds is not an array");
      return {
        gatewayEpoch: text(dataset["gatewayEpoch"], "gatewayEpoch"),
        datasetId: text(dataset["datasetId"], "datasetId"),
        manifestObjectKey: text(dataset["manifestObjectKey"], "manifestObjectKey"),
        manifestSha256: text(dataset["manifestSha256"], "manifestSha256", SHA256_HEX),
        segmentIds: segmentIds.map((id, idIndex) => text(id, `segmentIds[${String(idIndex)}]`)),
        objectBytes: count(dataset["objectBytes"], "objectBytes"),
      };
    }),
    sourceEventsInside: root["sourceEventsInside"] as boolean,
    sourceEventsOutside: outside as IntentEvidence[],
    createdAt: text(root["createdAt"], "createdAt", ISO_INSTANT),
  };
}

/** Read a pin record, or `null` when the pin was never extracted. */
export async function readPinRecord(objectStore: ObjectStore, pinId: string): Promise<PinRecord | null> {
  const key = pinRecordKey(pinId);
  if ((await objectStore.head(key)) === null) return null;
  const record = parsePinRecord(await objectStore.get(key), key);
  if (record.pinId !== pinId) throw new Error(`pin record ${key} names another pin`);
  return record;
}

/** Whether a segment's receipt span overlaps a range. */
export function overlaps(
  span: { readonly fromMs: number; readonly toMs: number },
  range: { readonly fromMs: number; readonly toMs: number },
): boolean {
  return span.fromMs <= range.toMs && range.fromMs <= span.toMs;
}

/** A segment's receipt span from its research pointer, or `null` when it has no frames. */
export function pointerSpan(pointer: ResearchPointer): { fromMs: number; toMs: number } | null {
  if (pointer.minReceivedAt === null || pointer.maxReceivedAt === null) return null;
  return { fromMs: epochMsOf(pointer.minReceivedAt), toMs: epochMsOf(pointer.maxReceivedAt) };
}

/**
 * Re-verify a pin's datasets from the store: each manifest exists, hashes to
 * its sidecar and to the digest the record pins, and reads as an EXACT
 * manifest. Returns the parsed manifests, or throws. The deletion guard
 * re-checks the bytes of the very object that preserves a segment.
 */
export async function verifyPinManifests(
  objectStore: ObjectStore,
  record: PinRecord,
): Promise<ReadonlyMap<string, DatasetManifest>> {
  const manifests = new Map<string, DatasetManifest>();
  for (const dataset of record.datasets) {
    if ((await objectStore.head(dataset.manifestObjectKey)) === null) {
      throw new Error(`pin ${record.pinId}: manifest ${dataset.manifestObjectKey} is not in the store`);
    }
    const bytes = await objectStore.get(dataset.manifestObjectKey);
    const digest = sha256Hex(bytes);
    if (digest !== dataset.manifestSha256) {
      throw new Error(`pin ${record.pinId}: manifest ${dataset.manifestObjectKey} is not the one its record pins`);
    }
    const sidecar = Buffer.from(await objectStore.get(manifestDigestSidecarKey(dataset.manifestObjectKey)))
      .toString("utf8")
      .trim();
    if (sidecar !== digest) throw new Error(`pin ${record.pinId}: manifest does not match its digest sidecar`);
    // ADR-017 §3: the strict-JSON profile (a duplicate key is refused).
    const manifest = parseDatasetManifest(parseStrictJsonBytes(bytes));
    if (manifest.datasetId !== dataset.datasetId) {
      throw new Error(`pin ${record.pinId}: manifest ${dataset.manifestObjectKey} names another dataset`);
    }
    manifests.set(dataset.manifestObjectKey, manifest);
  }
  return manifests;
}

export type PinExtractionContext = {
  readonly objectStore: ObjectStore;
  readonly fileSystem: CompactionFileSystem;
  readonly clock: CompactionClock;
  /** Every sealed segment of every epoch. */
  readonly segments: readonly InventoriedSegment[];
  /** Research pointers by segment id: every extracted segment. */
  readonly pointers: ReadonlyMap<string, ResearchPointer>;
  /** Segments the research-tier extractor refused. They can never be pinned (or expire). */
  readonly refusedSegmentIds: ReadonlySet<string>;
  /** The sealed WAL in dispatch order: where a source event named by identity lies (`wal-index.ts`). */
  readonly wal: WalIndex;
};

/** What happened to one pin spec in a cycle. */
export type PinOutcome =
  | { readonly pinId: string; readonly status: "already-extracted"; readonly record: PinRecord }
  | { readonly pinId: string; readonly status: "extracted"; readonly record: PinRecord }
  | { readonly pinId: string; readonly status: "waiting"; readonly reason: string };

/** The source events that do NOT lie inside the pinned segments (Decision 3.4). */
function sourceEventsOutside(
  spec: PinSpec,
  pinned: readonly { readonly segment: InventoriedSegment; readonly pointer: ResearchPointer }[],
  wal: WalIndex,
): readonly IntentEvidence[] {
  const pinnedIds = new Set(pinned.map(({ segment }) => segment.segmentId));
  const outside: IntentEvidence[] = [];
  for (const event of spec.sourceEvents) {
    let inside: boolean;
    if (event.gatewayEpoch !== null && event.ingestSeq !== null) {
      // The source event's own dispatch identity: the segment holding it
      // (`locateSourceEvent`, the same rule the classifier widened by) must
      // be one the pin holds.
      const location = locateSourceEvent(wal, event.gatewayEpoch, event.ingestSeq);
      inside = location.status === "located" && pinnedIds.has(location.segmentId);
    } else {
      // Only the event's instant is durable (`H1R1-PROVENANCE`): a pinned
      // segment must have received frames around it.
      inside = pinned.some(({ pointer }) => {
        const span = pointerSpan(pointer);
        return span !== null && span.fromMs <= event.evaluatedAtMs && event.evaluatedAtMs <= span.toMs;
      });
    }
    if (!inside) outside.push(event);
  }
  return outside;
}

/**
 * Extract one pin, or report why it must wait. Idempotent: an existing
 * record is re-verified and returned; an existing dataset left by an
 * interrupted run is adopted only when it verifies and holds the same
 * segments.
 */
export async function extractPin(spec: PinSpec, context: PinExtractionContext): Promise<PinOutcome> {
  const existing = await readPinRecord(context.objectStore, spec.pinId);
  if (existing !== null) {
    await verifyPinManifests(context.objectStore, existing);
    return { pinId: spec.pinId, status: "already-extracted", record: existing };
  }

  // Every sealed segment must be extracted (so its receipt span is known) or
  // refused before the pin's membership can be decided.
  const pending = context.segments.filter(
    (segment) => !context.pointers.has(segment.segmentId) && !context.refusedSegmentIds.has(segment.segmentId),
  );
  if (pending.length > 0) {
    return { pinId: spec.pinId, status: "waiting", reason: `${String(pending.length)} sealed segment(s) are not extracted yet` };
  }
  // The WAL must have moved past the range. As ADR-029 Decision 5.1 closes a
  // span, a range closes at the first frame, in dispatch order, received after
  // it: once a sealed, extracted segment holds such a frame, every frame
  // dispatched before it is sealed too. (A later frame stamped back inside the
  // range is outside the pin by that rule; a segment holding one overlaps the
  // range without being pinned, so the planner keeps it — fail closed.)
  const pastRange = [...context.pointers.values()].some((pointer) => {
    const span = pointerSpan(pointer);
    return span !== null && span.toMs > spec.toMs;
  });
  if (!pastRange) {
    return { pinId: spec.pinId, status: "waiting", reason: "the WAL has not yet moved past the pinned range" };
  }

  const members = context.segments
    .map((segment) => ({ segment, pointer: context.pointers.get(segment.segmentId) }))
    .filter((entry): entry is { segment: InventoriedSegment; pointer: ResearchPointer } => {
      if (entry.pointer === undefined) return false;
      const span = pointerSpan(entry.pointer);
      return span !== null && overlaps(span, { fromMs: spec.fromMs, toMs: spec.toMs });
    });

  // One exact dataset per (epoch, directory): the compactor is single-epoch.
  const groups = new Map<string, { gatewayEpoch: string; walDirectoryPath: string; members: typeof members }>();
  for (const member of members) {
    const key = `${member.segment.gatewayEpoch}\u0000${member.segment.walDirectoryPath}`;
    const group = groups.get(key) ?? {
      gatewayEpoch: member.segment.gatewayEpoch,
      walDirectoryPath: member.segment.walDirectoryPath,
      members: [],
    };
    group.members.push(member);
    groups.set(key, group);
  }

  const datasets: PinDataset[] = [];
  for (const group of [...groups.values()].sort((left, right) => (left.gatewayEpoch < right.gatewayEpoch ? -1 : 1))) {
    const datasetId = `pin-${spec.pinId}-${group.gatewayEpoch}`;
    const prefix = `${PIN_KEY_PREFIX}/${spec.pinId}/${group.gatewayEpoch}`;
    const manifestObjectKey = `${prefix}/${DATASET_MANIFEST_OBJECT_NAME}`;
    const segmentIds = group.members.map((member) => member.segment.segmentId);
    let manifest: DatasetManifest;
    let manifestSha256: string;
    if ((await context.objectStore.head(manifestObjectKey)) === null) {
      const result = await compactWalDirectory({
        walDirectoryPath: group.walDirectoryPath,
        datasetId,
        objectKeyPrefix: prefix,
        objectStore: context.objectStore,
        fileSystem: context.fileSystem,
        clock: context.clock,
        // A pin deletes nothing: retention stays with ADR-028's expiry path.
        retention: retainAllWalSegments(),
        codec: "SNAPPY",
        segmentIds,
      });
      if (result.refusedSegments.length > 0) {
        throw new Error(
          `pin ${spec.pinId}: the compactor refused ${result.refusedSegments.map((entry) => entry.segmentId).join(", ")}`,
        );
      }
      manifest = result.manifest;
      manifestSha256 = result.manifestSha256;
    } else {
      const bytes = await context.objectStore.get(manifestObjectKey);
      manifestSha256 = sha256Hex(bytes);
      manifest = parseDatasetManifest(parseStrictJsonBytes(bytes));
    }
    // ADR-028 Decision 2.6: every overlapping pin manifest lists the same two
    // digests for a segment as the research tier does.
    const pinnedIds = new Set(manifest.segments.map((entry) => entry.segmentId));
    for (const member of group.members) {
      const entry = manifest.segments.find((candidate) => candidate.segmentId === member.segment.segmentId);
      if (
        entry === undefined ||
        entry.segmentSha256 !== member.pointer.segmentSha256 ||
        entry.segmentFileSha256 !== member.pointer.segmentFileSha256
      ) {
        throw new Error(
          `pin ${spec.pinId}: segment ${member.segment.segmentId} is not pinned with the digests the research tier holds`,
        );
      }
    }
    if (pinnedIds.size !== segmentIds.length) {
      throw new Error(`pin ${spec.pinId}: dataset ${datasetId} holds other segments than the pin's`);
    }
    datasets.push({
      gatewayEpoch: group.gatewayEpoch,
      datasetId,
      manifestObjectKey,
      manifestSha256,
      segmentIds,
      objectBytes: manifest.objects.reduce((sum, object) => sum + object.byteLength, 0),
    });
  }

  const outside = sourceEventsOutside(spec, members, context.wal);
  const record: PinRecord = {
    pinRecordVersion: PIN_RECORD_VERSION,
    pinId: spec.pinId,
    origin: spec.origin,
    pinClass: spec.pinClass,
    windowId: spec.windowId,
    from: new Date(spec.fromMs).toISOString(),
    to: new Date(spec.toMs).toISOString(),
    keepUntil: spec.keepUntilMs === null ? null : new Date(spec.keepUntilMs).toISOString(),
    reason: spec.reason,
    datasets,
    sourceEventsInside: outside.length === 0,
    sourceEventsOutside: outside,
    createdAt: new Date(context.clock.nowMs()).toISOString(),
  };
  // Verified before it is recorded: a record is the statement that it is.
  await verifyPinManifests(context.objectStore, record);
  await context.objectStore.put(pinRecordKey(spec.pinId), Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
  return { pinId: spec.pinId, status: "extracted", record };
}
