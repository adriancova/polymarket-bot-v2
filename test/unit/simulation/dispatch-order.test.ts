/**
 * WP-210 acceptance 1: **replay follows dispatch order, not sorted venue time**
 * (§8.4, §6 invariant 15).
 *
 * The load-bearing probe is `venue-timestamp order differs from dispatch order`:
 * it replays a fixture where the two DISAGREE and shows that the delivered
 * sequence is the dispatch one. A test that only asserted "the events came out
 * in some order" would pass against an implementation that sorted by venue time,
 * which is exactly the failure §8.4 forbids.
 *
 * The rest of the suite is the other half of §8.4 and §8.3: a gap, an
 * unjustified exclusion, a cross-epoch dataset, a corrupted object and a
 * corrupted single record are REFUSED, never silently skipped.
 */

import { describe, expect, it } from "vitest";

import {
  DatasetEventSource,
  loadDataset,
  readDatasetManifestText,
  runEventSource,
  type EventEnvelope,
} from "../../../packages/simulation/src/index.js";

import {
  GATEWAY_EPOCH,
  OBJECT_KEY,
  OTHER_EPOCH,
  OUT_OF_ORDER_VENUE_FRAMES,
  buildDataset,
  datasetRow,
  sha256Hex,
  venueTimestampNormalizer,
  type FrameSpec,
} from "./fixtures.js";

function manifestOf(fixture: { readonly manifestText: string }) {
  const dataset = readDatasetManifestText(fixture.manifestText);
  if (!dataset.ok) throw new Error(`fixture manifest is invalid: ${dataset.refusal.message}`);
  return dataset.value;
}

/**
 * Re-pins a fixture manifest's object digest and length to the supplied bytes.
 *
 * Needed because the OBJECT CHECKSUM is the first gate: without re-pinning,
 * every probe that alters rows would be caught by the digest and would never
 * reach the ordering, gap and reconciliation checks it is aimed at. The digest
 * has its own probes above.
 */
function repinObject(
  fixture: { readonly manifestText: string },
  bytes: Uint8Array,
) {
  const dataset = manifestOf(fixture);
  const pin = dataset.objects[0];
  if (pin === undefined) throw new Error("fixture manifest pins no object");
  const rewritten = readDatasetManifestText(
    fixture.manifestText
      .replace(pin.sha256, sha256Hex(bytes))
      .replace(`"byteLength": ${String(pin.byteLength)}`, `"byteLength": ${String(bytes.length)}`),
  );
  if (!rewritten.ok) throw new Error(`re-pinned manifest is invalid: ${rewritten.refusal.message}`);
  return rewritten.value;
}

async function deliver(fixture: ReturnType<typeof buildDataset>): Promise<readonly EventEnvelope<unknown>[]> {
  const loaded = await loadDataset({
    dataset: manifestOf(fixture),
    archive: fixture.archive,
    digestSha256: sha256Hex,
  });
  if (!loaded.ok) throw new Error(`load refused: ${loaded.refusal.code} ${loaded.refusal.message}`);
  const source = DatasetEventSource.create(loaded.value, venueTimestampNormalizer());
  if (!source.ok) throw new Error(`source refused: ${source.refusal.message}`);
  const drained = await runEventSource(source.value);
  if (!drained.ok) throw new Error(`drain refused: ${drained.refusal.message}`);
  return drained.value;
}

describe("acceptance 1 — replay follows dispatch order, not sorted venue time", () => {
  it("delivers dispatch order on a fixture where venue-timestamp order DIFFERS", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const delivered = await deliver(fixture);

    const dispatchOrder = delivered.map((envelope) => envelope.ingestSeq);
    expect(dispatchOrder).toEqual(["1", "2", "3"]);

    // The independent oracle: sort the SAME delivered envelopes by the venue's
    // own timestamp. If the two orders were equal the probe would prove nothing,
    // so the fixture is asserted to be one where they disagree.
    const venueTimeOrder = [...delivered]
      .sort((left, right) => String(left.venueTimestamp).localeCompare(String(right.venueTimestamp)))
      .map((envelope) => envelope.ingestSeq);
    expect(venueTimeOrder).toEqual(["2", "3", "1"]);
    expect(venueTimeOrder).not.toEqual(dispatchOrder);
  });

  it("delivers dispatch order when the recorded WALL CLOCK regresses mid-stream", async () => {
    // A wall-clock step backwards inside one gateway epoch. `wal-format.md`
    // §12.1 records that frame wall clocks are not monotonic, so a replay that
    // ordered by `receivedAt` would reorder the stream here.
    const frames: readonly FrameSpec[] = [
      { ingestSeq: "1", receivedAt: "2026-01-01T00:00:05.000Z", receivedMonotonicNs: "1000", payloadUtf8: "a" },
      { ingestSeq: "2", receivedAt: "2026-01-01T00:00:01.000Z", receivedMonotonicNs: "2000", payloadUtf8: "b" },
      { ingestSeq: "3", receivedAt: "2026-01-01T00:00:09.000Z", receivedMonotonicNs: "3000", payloadUtf8: "c" },
    ];
    const fixture = buildDataset({ frames });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.value.records.map((record) => record.frame.ingestSeq)).toEqual(["1", "2", "3"]);
    // The regression is OBSERVED and reported, never used to reorder.
    expect(loaded.value.report.venueTimestampInversions).toBe(1);

    const delivered = await deliver(fixture);
    expect(delivered.map((envelope) => envelope.ingestSeq)).toEqual(["1", "2", "3"]);
  });

  it("refuses a dataset whose eligible rows are not increasing in ingestSeq", async () => {
    const frames: readonly FrameSpec[] = [
      { ingestSeq: "5", receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: "1000", payloadUtf8: "a" },
      { ingestSeq: "2", receivedAt: "2026-01-01T00:00:01.000Z", receivedMonotonicNs: "2000", payloadUtf8: "b" },
    ];
    const fixture = buildDataset({ frames });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("REPLAY_DISPATCH_ORDER_INCONSISTENT");
  });
});

describe("§8.3 — nothing is skipped in silence", () => {
  it("refuses a short object instead of returning a shorter stream", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const holed = fixture.rows.filter((_row, index) => index !== 1);
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(holed), "utf8"));
    const loaded = await loadDataset({
      dataset: repinObject(fixture, bytes),
      archive: {
        readObject: async () => await Promise.resolve({ objectKey: OBJECT_KEY, bytes, rows: holed }),
      },
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    // The manifest pins `rowCount: 3` for this object, so two rows is a refusal
    // rather than a two-event replay. The refusal names the manifest's number.
    expect(loaded.refusal.code).toBe("REPLAY_COUNTS_UNRECONCILED");
    expect(loaded.refusal.details["pinned"]).toBe(3);
  });

  it("refuses an ordinal gap the manifest's own counts do not explain", async () => {
    const frames: readonly FrameSpec[] = [
      { ingestSeq: "1", receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: "1000", payloadUtf8: "a" },
      { ingestSeq: "2", receivedAt: "2026-01-01T00:00:01.000Z", receivedMonotonicNs: "2000", payloadUtf8: "b" },
    ];
    const fixture = buildDataset({ frames });
    // Both rows present, but the second one's ordinal is 5 rather than 1.
    const rows = [datasetRow(frames[0] as FrameSpec, 0, 0), datasetRow(frames[1] as FrameSpec, 5, 1)];
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(rows), "utf8"));
    const loaded = await loadDataset({
      dataset: repinObject(fixture, bytes),
      archive: {
        readObject: async () => await Promise.resolve({ objectKey: OBJECT_KEY, bytes, rows }),
      },
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("REPLAY_ORDINAL_GAP");
  });

  it("refuses an exclusion the manifest never declared", async () => {
    const frames: readonly FrameSpec[] = [
      { ingestSeq: "1", receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: "1000", payloadUtf8: "a" },
      {
        ingestSeq: "2",
        receivedAt: "2026-01-01T00:00:01.000Z",
        receivedMonotonicNs: "2000",
        payloadUtf8: "b",
        replayEligible: false,
        exclusionReason: "incident:never-declared",
      },
    ];
    const fixture = buildDataset({ frames });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("REPLAY_EXCLUSION_UNDECLARED");
  });

  it("accepts an exclusion the manifest declares, and reports it", async () => {
    const frames: readonly FrameSpec[] = [
      { ingestSeq: "1", receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: "1000", payloadUtf8: "a" },
      {
        ingestSeq: "2",
        receivedAt: "2026-01-01T00:00:01.000Z",
        receivedMonotonicNs: "2000",
        payloadUtf8: "b",
        replayEligible: false,
        exclusionReason: "incident:inc-1",
      },
      { ingestSeq: "3", receivedAt: "2026-01-01T00:00:02.000Z", receivedMonotonicNs: "3000", payloadUtf8: "c" },
    ];
    const fixture = buildDataset({
      frames,
      windows: [
        { incidentId: "inc-1", fromIngestSeq: "2", toIngestSeq: "2", excludedRecordCount: 1 },
      ],
    });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.records.map((record) => record.frame.ingestSeq)).toEqual(["1", "3"]);
    expect(loaded.value.report.rowsExcludedByIncident).toBe(1);
    expect(loaded.value.report.rowsDelivered).toBe(2);
  });

  it("refuses an exclusion whose declared window does not contain the row", async () => {
    const frames: readonly FrameSpec[] = [
      { ingestSeq: "1", receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: "1000", payloadUtf8: "a" },
      {
        ingestSeq: "2",
        receivedAt: "2026-01-01T00:00:01.000Z",
        receivedMonotonicNs: "2000",
        payloadUtf8: "b",
        replayEligible: false,
        exclusionReason: "incident:inc-1",
      },
    ];
    const fixture = buildDataset({
      frames,
      windows: [
        { incidentId: "inc-1", fromIngestSeq: "40", toIngestSeq: "50", excludedRecordCount: 1 },
      ],
    });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("REPLAY_EXCLUSION_UNDECLARED");
  });
});

describe("§8.4 checksums and wal-format.md §12.1 cross-epoch chronology", () => {
  it("refuses an object whose bytes do not hash to the manifest's pin", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    // SAME LENGTH, different bytes. A longer or shorter object would be caught
    // by the byteLength comparison first, and the DIGEST check — the one §8.4
    // makes the trust boundary — would never run. (Mutation probe M6 found
    // exactly that hole in this test's first draft: disabling the digest
    // comparison left the suite green.)
    const tampered = new Uint8Array(fixture.objectBytes);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
    expect(tampered.length).toBe(fixture.objectBytes.length);
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: {
        readObject: async () =>
          await Promise.resolve({ objectKey: OBJECT_KEY, bytes: tampered, rows: fixture.rows }),
      },
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("REPLAY_OBJECT_CHECKSUM_MISMATCH");
  });

  it("refuses an object whose LENGTH does not match the manifest's pin", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const longer = new Uint8Array(Buffer.from(`${JSON.stringify(fixture.rows)} `, "utf8"));
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: {
        readObject: async () =>
          await Promise.resolve({ objectKey: OBJECT_KEY, bytes: longer, rows: fixture.rows }),
      },
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("REPLAY_OBJECT_CHECKSUM_MISMATCH");
    expect(loaded.refusal.message).toContain("bytes and the manifest pins");
  });

  it("refuses ONE corrupted record inside an object whose overall digest matched", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const rows = JSON.parse(JSON.stringify(fixture.rows)) as {
      record: { payloadUtf8: string };
    }[];
    const target = rows[1];
    if (target !== undefined) target.record.payloadUtf8 = "tampered";
    const bytes = new Uint8Array(Buffer.from(JSON.stringify(rows), "utf8"));
    // The manifest pin is recomputed for the tampered bytes, so the OBJECT
    // digest matches and only the per-record check can catch this.
    const loaded = await loadDataset({
      dataset: repinObject(fixture, bytes),
      archive: {
        readObject: async () => await Promise.resolve({ objectKey: OBJECT_KEY, bytes, rows }),
      },
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("REPLAY_SEGMENT_CHECKSUM_MISMATCH");
  });

  it("refuses a manifest that names two gateway epochs (wal-format.md §12.1)", () => {
    const fixture = buildDataset({
      frames: OUT_OF_ORDER_VENUE_FRAMES,
      gatewayEpochs: [GATEWAY_EPOCH, OTHER_EPOCH],
    });
    const dataset = readDatasetManifestText(fixture.manifestText);
    expect(dataset.ok).toBe(false);
    if (dataset.ok) return;
    expect(dataset.refusal.code).toBe("REPLAY_CROSS_EPOCH_CHRONOLOGY_UNDEFINED");
    expect(dataset.refusal.message).toContain("identity, not chronology");
  });

  it("refuses a ROW whose gateway epoch the dataset does not name", async () => {
    const frames: readonly FrameSpec[] = [
      { ingestSeq: "1", receivedAt: "2026-01-01T00:00:00.000Z", receivedMonotonicNs: "1000", payloadUtf8: "a" },
      {
        ingestSeq: "2",
        receivedAt: "2026-01-01T00:00:01.000Z",
        receivedMonotonicNs: "2000",
        payloadUtf8: "b",
        gatewayEpoch: OTHER_EPOCH,
      },
    ];
    const fixture = buildDataset({ frames });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.refusal.code).toBe("REPLAY_CROSS_EPOCH_CHRONOLOGY_UNDEFINED");
  });

  it("verifies WAL segment whole-file digests when the segments still exist", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const good = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
      walSegments: {
        read: async () => await Promise.resolve(new Uint8Array(Buffer.from("segment-file", "utf8"))),
      },
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.report.walSegmentVerification).toBe("VERIFIED");

    const bad = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
      walSegments: {
        read: async () => await Promise.resolve(new Uint8Array(Buffer.from("different", "utf8"))),
      },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.refusal.code).toBe("REPLAY_SEGMENT_CHECKSUM_MISMATCH");
  });

  it("says NOT_AVAILABLE_ARCHIVED_ONLY rather than implying a check happened", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.report.walSegmentVerification).toBe("NOT_AVAILABLE_ARCHIVED_ONLY");
  });
});

describe("the normalizer may not restate provenance", () => {
  it("stops the stream when an envelope's (gatewayEpoch, ingestSeq) differ from the record", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const liar = venueTimestampNormalizer();
    const source = DatasetEventSource.create(loaded.value, {
      normalizerVersion: liar.normalizerVersion,
      normalize(record) {
        const outcome = liar.normalize(record);
        if (!outcome.ok) return outcome;
        return {
          ok: true,
          envelopes: outcome.envelopes.map((envelope) => ({ ...envelope, ingestSeq: "9999" })),
        };
      },
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const drained = await runEventSource(source.value);
    expect(drained.ok).toBe(false);
    if (drained.ok) return;
    expect(drained.refusal.code).toBe("REPLAY_NORMALIZER_REFUSED");
    expect(drained.refusal.message).toContain("provenance");
  });

  it("stops the stream when the normalizer refuses a recorded frame", async () => {
    const fixture = buildDataset({ frames: OUT_OF_ORDER_VENUE_FRAMES });
    const loaded = await loadDataset({
      dataset: manifestOf(fixture),
      archive: fixture.archive,
      digestSha256: sha256Hex,
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    const source = DatasetEventSource.create(loaded.value, {
      normalizerVersion: "test/venue-ts/v1",
      normalize: () => ({ ok: false, reason: "modelled refusal" }),
    });
    expect(source.ok).toBe(true);
    if (!source.ok) return;
    const drained = await runEventSource(source.value);
    expect(drained.ok).toBe(false);
    if (drained.ok) return;
    expect(drained.refusal.code).toBe("REPLAY_NORMALIZER_REFUSED");
  });
});
