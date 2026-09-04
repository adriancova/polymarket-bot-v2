/**
 * The golden replay (§12.4: "CI runs a small golden replay on every change to
 * core contracts").
 *
 * The fixture is `test/replay-golden/simulation/golden-replay.json`; its
 * provenance and the derivation of every expected line are in the README beside
 * it. The expected serialization is written out as literal lines in the FIXTURE,
 * derived by hand from `serializeRun`'s published grammar and the fixture's own
 * inputs — not captured from a run. A change to the format, the ordering, the
 * clock accounting, or the reconciliation counters moves these bytes, and moving
 * them requires re-deriving them.
 *
 * The suite also asserts the two things a golden test is for beyond its own
 * bytes: the run is reproducible (same bytes twice) and it is SENSITIVE (a
 * one-character change to the dataset changes the bytes).
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  deriveReplayEventId,
  readDatasetManifestText,
  runReplay,
  type ArchivedObject,
  type DatasetArchiveReader,
  type NormalizeOutcome,
  type ReplayNormalizer,
  type ReplayRecord,
  type ReplayRunPins,
  type Sha256HexDigest,
} from "../../../packages/simulation/src/index.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXTURE_PATH = join(REPO_ROOT, "test", "replay-golden", "simulation", "golden-replay.json");

const sha256Hex: Sha256HexDigest = (bytes) => createHash("sha256").update(bytes).digest("hex");

interface GoldenFixture {
  readonly manifest: unknown;
  readonly rows: readonly unknown[];
  readonly runPins: ReplayRunPins;
  readonly expected: { readonly serialization: readonly string[] };
}

function loadFixture(): GoldenFixture {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as GoldenFixture;
}

/**
 * The golden normalizer.
 *
 * It performs the one interpretation the golden replay needs — surfacing the
 * venue's own `timestamp` as the envelope's `venueTimestamp` — and copies every
 * provenance field verbatim. Its version matches the fixture's run pin.
 */
function goldenNormalizer(): ReplayNormalizer {
  return {
    normalizerVersion: "golden/market-frame/v1",
    normalize(record: ReplayRecord): NormalizeOutcome {
      let venueTimestamp: string | undefined;
      let eventType = "MarketFrame";
      try {
        const parsed = JSON.parse(record.frame.payloadUtf8) as {
          timestamp?: unknown;
          event_type?: unknown;
        };
        if (typeof parsed.timestamp === "string") {
          venueTimestamp = new Date(Number(parsed.timestamp)).toISOString();
        }
        if (typeof parsed.event_type === "string") eventType = parsed.event_type;
      } catch {
        return { ok: false, reason: "the recorded payload is not JSON" };
      }
      const eventId = deriveReplayEventId(sha256Hex, {
        gatewayEpoch: record.frame.gatewayEpoch,
        ingestSeq: record.frame.ingestSeq,
        receivedAt: record.frame.receivedAt,
        index: 0,
      });
      if (!eventId.ok) return { ok: false, reason: eventId.refusal.message };
      return {
        ok: true,
        envelopes: [
          {
            eventId: eventId.value,
            eventType,
            schemaVersion: 1,
            source: "polymarket",
            sourceChannel: "market",
            ...(venueTimestamp === undefined ? {} : { venueTimestamp }),
            receivedAt: record.frame.receivedAt,
            receivedMonotonicNs: record.frame.receivedMonotonicNs,
            gatewayEpoch: record.frame.gatewayEpoch,
            ingestSeq: record.frame.ingestSeq,
            payload: record.frame.payloadUtf8,
          },
        ],
      };
    },
  };
}

function archiveOf(fixture: GoldenFixture, rows: readonly unknown[] = fixture.rows): DatasetArchiveReader {
  const bytes = new Uint8Array(Buffer.from(JSON.stringify(rows), "utf8"));
  return {
    async readObject(objectKey: string): Promise<ArchivedObject> {
      return await Promise.resolve({ objectKey, bytes, rows });
    },
  };
}

async function replay(fixture: GoldenFixture, rows?: readonly unknown[]) {
  const dataset = readDatasetManifestText(`${JSON.stringify(fixture.manifest, null, 2)}\n`);
  if (!dataset.ok) throw new Error(`golden manifest refused: ${dataset.refusal.message}`);
  return await runReplay({
    dataset: dataset.value,
    archive: archiveOf(fixture, rows),
    digestSha256: sha256Hex,
    normalizer: goldenNormalizer(),
    runPins: fixture.runPins,
  });
}

describe("the golden replay", () => {
  it("produces exactly the pinned bytes", async () => {
    const fixture = loadFixture();
    const result = await replay(fixture);
    expect(result.ok, result.ok ? "" : `${result.refusal.code}: ${result.refusal.message}`).toBe(true);
    if (!result.ok) return;
    expect(result.value.serialization.split("\n")).toEqual([...fixture.expected.serialization]);
    expect(result.value.serialization).toBe(fixture.expected.serialization.join("\n"));
  });

  it("delivers the recorded dispatch order, which is NOT the venue-timestamp order", async () => {
    const fixture = loadFixture();
    const result = await replay(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.eventsDelivered).toBe(3);
    // The fixture's venue timestamps are 1782753357257, …357000, …357500 — so
    // venue-time order is (4, 1, 9) and dispatch order is (1, 4, 9).
    expect(result.value.load.venueTimestampInversions).toBe(1);
  });

  it("is reproducible: two runs are byte-identical", async () => {
    const fixture = loadFixture();
    const first = await replay(fixture);
    const second = await replay(fixture);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value.serialization).toBe(first.value.serialization);
  });

  it("is SENSITIVE: changing one recorded byte changes the outcome", async () => {
    const fixture = loadFixture();
    const rows = JSON.parse(JSON.stringify(fixture.rows)) as {
      record: { payloadUtf8: string; payloadSha256: string };
    }[];
    const target = rows[1];
    if (target !== undefined) {
      target.record.payloadUtf8 = target.record.payloadUtf8.replace('"0.08"', '"0.09"');
    }
    const result = await replay(fixture, rows);
    // The per-record checksum catches it before the ordering does: the
    // manifest's own pins are the trust boundary (§8.4).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(["REPLAY_OBJECT_CHECKSUM_MISMATCH", "REPLAY_SEGMENT_CHECKSUM_MISMATCH"]).toContain(
      result.refusal.code,
    );
  });

  it("refuses a run whose §12.5 pins are incomplete", async () => {
    const fixture = loadFixture();
    const dataset = readDatasetManifestText(`${JSON.stringify(fixture.manifest, null, 2)}\n`);
    expect(dataset.ok).toBe(true);
    if (!dataset.ok) return;
    const result = await runReplay({
      dataset: dataset.value,
      archive: archiveOf(fixture),
      digestSha256: sha256Hex,
      normalizer: goldenNormalizer(),
      runPins: { ...fixture.runPins, fillModelVersion: "" },
    });
    expect(result.ok).toBe(false);
  });
});
