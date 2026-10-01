/**
 * The sealed WAL in dispatch order, built from the real research tier
 * (`STORAGE-1` round 1, J5 and J8): verified facts from the verified manifest,
 * and, for a segment without one, its sidecar's facts widened — used only to
 * hold.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { verifyResearchTierDataset } from "@polymarket-bot/storage-parquet";

import { researchPointerKey } from "../research-tier/extract.js";
import { EPOCH, HOUR, storageFixture, tradeFrame } from "../testing/storage-fixture.js";
import type { StorageFixture } from "../testing/storage-fixture.js";
import { UNVERIFIED_ENVELOPE_MARGIN_MS, buildWalIndex, cachedResearchVerifier, dispatchRequirements } from "./wal-index.js";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");
const T = NOW - 80 * HOUR;
const MIN = 60 * 1000;

let fixture: StorageFixture | null = null;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = null;
});

describe("buildWalIndex", () => {
  it("takes verified segments' spans and ingest ranges from the verified manifest, and widens an unverified one's", async () => {
    fixture = await storageFixture({
      nowMs: NOW,
      segments: [
        [tradeFrame({ ingestSeq: "1", atMs: T }), tradeFrame({ ingestSeq: "2", atMs: T + MIN })],
        [tradeFrame({ ingestSeq: "3", atMs: T + 10 * MIN })],
        [tradeFrame({ ingestSeq: "4", atMs: T + 3 * HOUR })],
      ],
    });
    const inventory = await fixture.extract();
    // Segment 1 loses its research tier: it is no longer verified.
    await rm(join(fixture.root, "objects", researchPointerKey(EPOCH, fixture.segments[1]?.segmentId ?? "")));
    const store = fixture.objectStore;
    const index = await buildWalIndex({
      objectStore: store,
      inventory,
      refusedSegmentIds: new Set([fixture.segments[2]?.segmentId ?? ""]),
      verifiedResearch: cachedResearchVerifier((key) => verifyResearchTierDataset(store, key)),
    });
    const [zero, one, two] = index.byEpoch.get(EPOCH) ?? [];
    expect(zero).toMatchObject({ verified: true, refused: false, firstIngestSeq: "1", lastIngestSeq: "2", span: { fromMs: T, toMs: T + MIN } });
    expect(one?.verified).toBe(false);
    expect(one?.refused).toBe(false);
    expect(one?.firstIngestSeq).toBe("3");
    // The sidecar's instants (the fixture's sidecar is stamped 2026-01-01T00:00-00:15) and
    // the frame's, widened by the margin on each side.
    expect(one?.span).toStrictEqual({
      fromMs: Date.parse("2026-01-01T00:00:00.000Z") - UNVERIFIED_ENVELOPE_MARGIN_MS,
      toMs: T + 10 * MIN + UNVERIFIED_ENVELOPE_MARGIN_MS,
    });
    // Segment 2 still verifies; a refusal applies only to an unverified segment.
    expect(two?.verified).toBe(true);

    // A window whose range touches only segment 1's envelope must wait for the
    // trader past the segment sealed after it.
    const requirements = dispatchRequirements(index, { fromMs: T + 20 * MIN, toMs: T + 30 * MIN });
    expect(requirements).toStrictEqual({ ok: true, requirements: [{ gatewayEpoch: EPOCH, kind: "past-segment", ingestSeq: "4" }] });
  });
});
