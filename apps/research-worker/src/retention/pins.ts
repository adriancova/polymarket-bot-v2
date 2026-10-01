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
 * ## A pin is a durable fact, not a per-cycle derivation
 *
 * Once a record exists, the pin exists, whatever later cycles derive. The
 * planner treats EVERY record in the store whose range overlaps a segment as
 * an overlapping pin (`readExtractedPins`; ADR-028 Decision 2.4): a window
 * that is unclassified for a cycle (the trader's database unreachable, a
 * source event pending), removed from the registry, or re-derived with
 * another range still has its pin verified and named before a segment it
 * covers expires.
 *
 * A window whose existing pin already fulfils what the window now requires is
 * **bound** to it (`bindWindowPins`) rather than re-pinned. That is what keeps
 * a window's pin stable after its chain-source segment expires under it: the
 * source event can no longer be located in the WAL, but the record names it
 * among the events it holds, so it is still inside the pin. When the source
 * event's whole gateway epoch has expired, the classifier resolves it through
 * the same pin (`ownPinSources`): its verified manifests still list the
 * segment the event lay in.
 *
 * ## A record is checked against what it claims (round 3, L2)
 *
 * A record's range decides which segments it obliges, so it is never trusted
 * alone. A window pin's id digests its class, range and source events
 * (`windowPinId`): a window record whose id does not recompute from its own
 * fields does not read (`pin-record-unreadable` keeps every segment). Every
 * segment a record's datasets list is obliged to it whatever its range says,
 * and a record whose range does not cover a segment it lists keeps that
 * segment (`plan.ts`).
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
  compareUnsignedIntegerStrings,
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
import { EPOCH_ENDING_CLOSE_REASONS, locateSourceEvent } from "./wal-index.js";
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
  /** The source events the pin had to hold (Decision 3.4): its spec's, as extracted. */
  readonly sourceEvents: readonly IntentEvidence[];
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
      pinId: windowPinId(
        classification.windowId,
        classification.pinClass,
        classification.pinFromMs,
        classification.pinToMs,
        classification.sourceEvents,
      ),
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
 * A window pin's id: the window, and a short digest of what the pin holds —
 * its class, its range and the source events it must hold. The events are
 * part of it because the record's `sourceEventsInside` is a statement about
 * exactly those events: a chain that names another event is another pin,
 * whose trace is checked anew, never an old record's verdict reused.
 *
 * A pin record is immutable. A window whose existing pin still fulfils what
 * it requires is bound to that pin (`bindWindowPins`). Should its evidence
 * ever imply more — a different class, a wider range, another source event —
 * the new range is a new pin with its own id, extracted beside the old one,
 * which is kept and still honoured (`readExtractedPins`), rather than a stuck
 * expiry or a rewritten record.
 */
export function windowPinId(
  windowId: string,
  pinClass: PinClass,
  fromMs: number,
  toMs: number,
  sourceEvents: readonly IntentEvidence[],
): string {
  const events = [...new Set(sourceEvents.map(sourceEventKey))].sort();
  const digest = sha256Hex(JSON.stringify([pinClass, fromMs, toMs, events])).slice(0, 12);
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
  const nullableText = (raw: unknown, what: string): string | null => (raw === null ? null : text(raw, what));
  // Every instant is one this build wrote: canonical, so its range is exactly
  // the one the planner compares (an instant that does not read would be no
  // range at all, and overlap nothing).
  const instant = (raw: unknown, what: string): string => {
    const value = text(raw, what, ISO_INSTANT);
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : fail(`${what} is not a canonical instant`);
  };
  const events = (raw: unknown, what: string): IntentEvidence[] =>
    (Array.isArray(raw) ? (raw as unknown[]) : fail(`${what} is not an array`)).map((item, index) => {
      const event = object(item, `${what}[${String(index)}]`);
      const evaluatedAtMs = event["evaluatedAtMs"];
      if (typeof evaluatedAtMs !== "number" || !Number.isSafeInteger(evaluatedAtMs)) fail(`${what}[${String(index)}].evaluatedAtMs is malformed`);
      return {
        evaluatedAtMs: evaluatedAtMs as number,
        sourceEventId: nullableText(event["sourceEventId"], `${what}[${String(index)}].sourceEventId`),
        gatewayEpoch: nullableText(event["gatewayEpoch"], `${what}[${String(index)}].gatewayEpoch`),
        ingestSeq: nullableText(event["ingestSeq"], `${what}[${String(index)}].ingestSeq`),
      };
    });
  const root = object(value, "the record");
  if (root["pinRecordVersion"] !== PIN_RECORD_VERSION) fail("an unknown pinRecordVersion");
  const origin = root["origin"];
  if (origin !== "window" && origin !== "operator") fail("origin is malformed");
  const pinClass = root["pinClass"];
  if (!["fill", "halt", "refusal", "intent", "operator"].includes(String(pinClass))) fail("pinClass is malformed");
  const datasets = Array.isArray(root["datasets"]) ? (root["datasets"] as unknown[]) : fail("datasets is not an array");
  const sourceEvents = events(root["sourceEvents"], "sourceEvents");
  const outside = events(root["sourceEventsOutside"], "sourceEventsOutside");
  if (typeof root["sourceEventsInside"] !== "boolean") fail("sourceEventsInside is not a boolean");
  if ((root["sourceEventsInside"] === true) !== (outside.length === 0)) fail("sourceEventsInside contradicts sourceEventsOutside");
  const from = instant(root["from"], "from");
  const to = instant(root["to"], "to");
  if (Date.parse(to) < Date.parse(from)) fail("the range ends before it starts");
  return {
    pinRecordVersion: PIN_RECORD_VERSION,
    pinId: text(root["pinId"], "pinId"),
    origin: origin as PinRecord["origin"],
    pinClass: pinClass as PinRecord["pinClass"],
    windowId: root["windowId"] === null ? null : text(root["windowId"], "windowId"),
    from,
    to,
    keepUntil: root["keepUntil"] === null ? null : instant(root["keepUntil"], "keepUntil"),
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
    sourceEvents,
    sourceEventsInside: root["sourceEventsInside"] as boolean,
    sourceEventsOutside: outside,
    createdAt: instant(root["createdAt"], "createdAt"),
  };
}

/**
 * Check that a record is the pin its id names (round 3, L2): a window pin's id
 * recomputes from the record's own window, class, range and source events
 * (`windowPinId`), so a record whose range or events were changed after it was
 * written no longer reads; an operator pin's record is an operator's.
 */
export function checkPinRecordIdentity(record: PinRecord, key: string): void {
  const fail = (what: string): never => {
    throw new Error(`pin record ${key} is not the pin its id names: ${what}`);
  };
  if (record.origin === "window") {
    if (record.windowId === null || record.pinClass === "operator") fail("a window pin without a window or a window class");
    const expected = windowPinId(
      record.windowId as string,
      record.pinClass as PinClass,
      Date.parse(record.from),
      Date.parse(record.to),
      record.sourceEvents,
    );
    if (expected !== record.pinId) fail(`its window, class, range and source events digest to ${expected}`);
  } else if (record.windowId !== null || record.pinClass !== "operator" || !record.pinId.startsWith("operator-")) {
    fail("an operator pin with a window, a window class or a window id");
  }
}

/** Read a pin record, or `null` when the pin was never extracted. */
export async function readPinRecord(objectStore: ObjectStore, pinId: string): Promise<PinRecord | null> {
  const key = pinRecordKey(pinId);
  if ((await objectStore.head(key)) === null) return null;
  const record = parsePinRecord(await objectStore.get(key), key);
  if (record.pinId !== pinId) throw new Error(`pin record ${key} names another pin`);
  checkPinRecordIdentity(record, key);
  return record;
}

/**
 * Every pin extracted into the store: the records that read, and the ones
 * that exist but do not (their range is unknown, so the planner keeps every
 * segment while any exists).
 */
export type ExtractedPins = {
  readonly records: readonly PinRecord[];
  readonly unreadable: readonly { readonly pinId: string; readonly detail: string }[];
};

/**
 * Enumerate every extracted pin (`pins/<pinId>/pin.json`), whatever this
 * cycle derives. A pin directory without a record is an extraction that did
 * not finish: nothing was ever deleted under it, and it is skipped. A store
 * that cannot list its keys, or a listing that fails, is ONE unreadable entry,
 * which keeps every segment.
 */
export async function readExtractedPins(objectStore: ObjectStore): Promise<ExtractedPins> {
  if (objectStore.list === undefined) {
    return { records: [], unreadable: [{ pinId: "(pin catalog)", detail: "the object store cannot list its keys" }] };
  }
  let names: readonly string[];
  try {
    names = await objectStore.list(PIN_KEY_PREFIX);
  } catch (error) {
    return {
      records: [],
      unreadable: [{ pinId: "(pin catalog)", detail: `the pins could not be listed: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  const records: PinRecord[] = [];
  const unreadable: { pinId: string; detail: string }[] = [];
  for (const name of names) {
    try {
      const record = await readPinRecord(objectStore, name);
      if (record !== null) records.push(record);
    } catch (error) {
      unreadable.push({ pinId: name, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { records, unreadable };
}

/** A source event's identity, for comparing the events a pin holds. */
function sourceEventKey(event: IntentEvidence): string {
  return JSON.stringify([event.evaluatedAtMs, event.sourceEventId, event.gatewayEpoch, event.ingestSeq]);
}

/** Whether a pin was extracted to hold every one of these source events. */
export function recordHoldsSourceEvents(record: PinRecord, events: readonly IntentEvidence[]): boolean {
  const held = new Set(record.sourceEvents.map(sourceEventKey));
  return events.every((event) => held.has(sourceEventKey(event)));
}

/**
 * Bind each window spec to the window's existing pin when that pin already
 * fulfils it, rather than derive a new pin.
 *
 * An existing record fulfils a spec when it is the same window's pin, of the
 * same class and lapse, its trace was complete (`sourceEventsInside`), its
 * range contains the spec's range, and it was extracted to hold every source
 * event the spec names. Then everything the spec must hold, the record holds.
 *
 * This is what keeps a window's pin stable over its life: once the segment
 * holding a chain source event expires under the pin (ADR-028 Decision 2.4),
 * the event can no longer be located in the WAL, so the window's freshly
 * derived range no longer reaches it — but the pin that holds it does.
 * Without the binding the window would be re-pinned with a narrower range
 * and an incomplete trace, and its remaining raw segments kept forever.
 *
 * A spec no record fulfils (new evidence, another class, a registry edit) is
 * kept as derived: a new pin, extracted beside the old one, which the planner
 * still honours (`readExtractedPins`).
 */
export function bindWindowPins(specs: readonly PinSpec[], records: readonly PinRecord[]): readonly PinSpec[] {
  const byId = new Set(records.map((record) => record.pinId));
  return specs.map((spec) => {
    if (spec.origin !== "window" || byId.has(spec.pinId)) return spec;
    const keepUntil = spec.keepUntilMs === null ? null : new Date(spec.keepUntilMs).toISOString();
    const candidates = records.filter((record) => {
      if (
        record.origin !== "window" ||
        record.windowId !== spec.windowId ||
        record.pinClass !== spec.pinClass ||
        record.keepUntil !== keepUntil ||
        !record.sourceEventsInside
      ) {
        return false;
      }
      const fromMs = Date.parse(record.from);
      const toMs = Date.parse(record.to);
      if (!(fromMs <= spec.fromMs && spec.toMs <= toMs)) return false;
      return recordHoldsSourceEvents(record, spec.sourceEvents);
    });
    const chosen = candidates.sort((left, right) =>
      left.createdAt !== right.createdAt ? (left.createdAt < right.createdAt ? -1 : 1) : left.pinId < right.pinId ? -1 : 1,
    )[0];
    if (chosen === undefined) return spec;
    return {
      ...spec,
      pinId: chosen.pinId,
      fromMs: Date.parse(chosen.from),
      toMs: Date.parse(chosen.to),
      sourceEvents: chosen.sourceEvents,
    };
  });
}

/**
 * Whether a pin's verified manifests hold the segment a source event
 * `(gatewayEpoch, ingestSeq)` lay in, by the rule `locateSourceEvent` applies
 * to the sealed WAL (`wal-index.ts`): the last pinned segment of the epoch
 * whose first `ingestSeq` is at or before the event holds it when the event is
 * not after its last frame, or when it is but the pin also holds the very next
 * segment of the epoch, or that segment ended its epoch. The pinned segments of
 * an epoch are a subset of the epoch's, so a segment found this way is the one
 * the event lay in.
 */
export function pinnedSegmentsHoldEvent(
  manifests: Iterable<DatasetManifest>,
  gatewayEpoch: string,
  ingestSeq: string,
): boolean {
  const segments = [...manifests]
    .flatMap((manifest) => manifest.segments)
    .filter((entry) => entry.gatewayEpoch === gatewayEpoch)
    .sort((left, right) => left.segmentIndex - right.segmentIndex);
  let holderPosition = -1;
  segments.forEach((entry, position) => {
    if (entry.firstIngestSeq !== null && compareUnsignedIntegerStrings(entry.firstIngestSeq, ingestSeq) <= 0) {
      holderPosition = position;
    }
  });
  const holder = segments[holderPosition];
  if (holder === undefined || holder.lastIngestSeq === null) return false;
  if (compareUnsignedIntegerStrings(ingestSeq, holder.lastIngestSeq) <= 0) return true;
  const next = segments[holderPosition + 1];
  if (next !== undefined) return next.segmentIndex === holder.segmentIndex + 1;
  return EPOCH_ENDING_CLOSE_REASONS.has(holder.closeReason);
}

/**
 * The classifier's resolver for a source event the sealed WAL no longer
 * locates (`classify.ts`, `pinnedSource`; round 3, L3): it lies inside the
 * window's OWN existing pin when a record of that window — complete trace,
 * extracted to hold exactly this event, its manifests verified now — holds the
 * segment it lay in (`pinnedSegmentsHoldEvent`). Only the window's own pins
 * count: Decision 3.4 requires the event inside the window's pin, not merely
 * inside some pin.
 *
 * A record whose manifests do not verify resolves nothing (the window then
 * waits, holding its range).
 */
export async function ownPinSources(
  objectStore: ObjectStore,
  records: readonly PinRecord[],
  windowIds: ReadonlySet<string>,
  verify: (record: PinRecord) => Promise<ReadonlyMap<string, DatasetManifest> | Error> = async (record) =>
    await verifyPinManifests(objectStore, record).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error)))),
): Promise<(window: { readonly windowId: string }, event: IntentEvidence) => boolean> {
  const verified: { readonly record: PinRecord; readonly manifests: readonly DatasetManifest[] }[] = [];
  for (const record of records) {
    if (record.origin !== "window" || record.windowId === null || !windowIds.has(record.windowId) || !record.sourceEventsInside) continue;
    const manifests = await verify(record);
    if (manifests instanceof Error) continue;
    verified.push({ record, manifests: [...manifests.values()] });
  }
  return (window, event) => {
    if (event.gatewayEpoch === null || event.ingestSeq === null) return false;
    const { gatewayEpoch, ingestSeq } = event;
    return verified.some(
      ({ record, manifests }) =>
        record.windowId === window.windowId &&
        recordHoldsSourceEvents(record, [event]) &&
        pinnedSegmentsHoldEvent(manifests, gatewayEpoch, ingestSeq),
    );
  };
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
  // A new window pin's id is the digest of what it holds, or its record would
  // never read back (`checkPinRecordIdentity`).
  if (
    spec.origin === "window" &&
    (spec.windowId === null ||
      spec.pinClass === "operator" ||
      spec.pinId !== windowPinId(spec.windowId, spec.pinClass, spec.fromMs, spec.toMs, spec.sourceEvents))
  ) {
    throw new Error(`pin ${spec.pinId}: a window pin's id must be the digest of its window, class, range and source events`);
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
    sourceEvents: spec.sourceEvents,
    sourceEventsInside: outside.length === 0,
    sourceEventsOutside: outside,
    createdAt: new Date(context.clock.nowMs()).toISOString(),
  };
  // Verified before it is recorded: a record is the statement that it is.
  await verifyPinManifests(context.objectStore, record);
  await context.objectStore.put(pinRecordKey(spec.pinId), Buffer.from(`${JSON.stringify(record, null, 2)}\n`, "utf8"));
  return { pinId: spec.pinId, status: "extracted", record };
}
