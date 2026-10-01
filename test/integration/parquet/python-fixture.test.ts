/**
 * The committed fixture the Python validator reads, and the test that keeps it
 * honest.
 *
 * ## Why a committed fixture exists at all
 *
 * `python/research/compaction` validates a dataset with DuckDB — an
 * independent implementation of the Parquet format. That is only evidence if
 * the file it reads was produced by **this** writer. Building one in Python
 * would prove DuckDB agrees with DuckDB; building one here and committing it
 * proves DuckDB agrees with `hyparquet-writer`, which is the actual question,
 * and it is also the cheapest possible regression test for the library-choice
 * risk written up in `docs/handoffs/WP-130.md`.
 *
 * ## Why the test compares bytes
 *
 * The dataset below is a pure function of a manual clock and a fixed frame
 * list, so recompacting it must reproduce the committed bytes exactly. A
 * mismatch means one of three things, all of which an operator wants to know
 * about: the layout changed, the writer library changed its output, or the
 * manifest gained a field. Regenerate with:
 *
 *     pnpm --filter @polymarket-bot/research-worker fixture:python
 *
 * and review the diff — a change to the bytes of an archive format is exactly
 * the kind of change `docs/contracts/wal-format.md` §12 says must be
 * deliberate.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  compactWalDirectory,
  nodeCompactionFileSystem,
  parseAnyDatasetManifest,
  parseStrictJsonBytes,
} from "@polymarket-bot/storage-parquet";
import { memoryObjectStore } from "@polymarket-bot/storage-parquet/testing";
import type { MemoryObjectStore } from "@polymarket-bot/storage-parquet/testing";
import type { CompactionClock, IncidentWindow } from "@polymarket-bot/storage-parquet";
import { extractResearchTier, inventoryWalRoot } from "@polymarket-bot/research-worker";

import { createWorkspace, frame, GATEWAY_EPOCH, recordFrames } from "./context.js";
import type { TemporaryWorkspace } from "./context.js";

const FIXTURE_ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
  "../../../python/research/compaction/testdata",
);

const FIXTURE_DATASET_ID = "ds-fixture";
const FIXTURE_PREFIX = `datasets/${FIXTURE_DATASET_ID}`;

const UPDATE = process.env["UPDATE_PYTHON_FIXTURE"] === "1";

/** A clock frozen at a fixed instant, so the fixture is reproducible. */
function frozenClock(): CompactionClock {
  const nowMs = Date.parse("2026-01-01T12:00:00.000Z");
  return { nowMs: () => nowMs, monotonicMs: () => 0 };
}

const FIXTURE_WINDOW: IncidentWindow = {
  incidentId: "inc-fixture-1",
  kind: "gap",
  gatewayEpoch: GATEWAY_EPOCH,
  fromIngestSeq: "4",
  toIngestSeq: "5",
  openedAt: "2026-01-01T00:00:03.000Z",
  closedAt: "2026-01-01T00:00:06.000Z",
  reason: "market channel gap recorded for the validator fixture",
};

/**
 * The frames the fixture records.
 *
 * Chosen to exercise what the validator must survive: exact decimal strings
 * with trailing zeros, a non-JSON heartbeat, an empty payload, a payload that
 * mimics a footer record, control characters, and an `ingestSeq` beyond the
 * INT64 range.
 */
const FIXTURE_FRAMES = [
  { ingestSeq: "1", payloadUtf8: '{"event_type":"book","bids":[{"price":"0.100","size":"1.0"}]}' },
  { ingestSeq: "2", payloadUtf8: "PING" },
  { ingestSeq: "3", payloadUtf8: "" },
  { ingestSeq: "4", payloadUtf8: '{"record":"footer","formatId":"polymarket-bot/wal/v1"}' },
  { ingestSeq: "5", payloadUtf8: "control\tchars and\u0000\u007fbytes" },
  { ingestSeq: "6", payloadUtf8: "emoji 😀 plus a literal backslash-n \\n" },
  { ingestSeq: "18446744073709551617", payloadUtf8: '{"price":"1.0000000000000000001"}' },
] as const;

let workspace: TemporaryWorkspace;

beforeEach(async () => {
  workspace = await createWorkspace();
});

afterEach(async () => {
  await workspace.cleanup();
});

/**
 * Which committed fixture to build (`STORAGE-1`):
 *
 * - `v1` — the `WP-130` fixture, still written as dataset-manifest version 1
 *   (ADR-029 Consequences: "Version 1 fixtures and goldens stay version 1 and
 *   keep passing"). Its bytes are unchanged;
 * - `v2` — the same frames, compacted as version 2 `exact`, what the compactor
 *   now writes by default;
 * - `research` — the same WAL through the research-tier extractor: a version 2
 *   `approximate` dataset for the Python reader.
 */
type FixtureKind = "v1" | "v2" | "research";

async function buildFixture(kind: FixtureKind = "v1"): Promise<MemoryObjectStore> {
  const frames = FIXTURE_FRAMES.map((input, index) =>
    frame({
      ingestSeq: input.ingestSeq,
      payloadUtf8: input.payloadUtf8,
      receivedAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
    }),
  );
  // 2200 bytes gives the writer room for two or three frames per segment, so
  // the fixture spans several segments (which is what makes cross-segment
  // ordinal assignment observable) without one object per frame.
  await recordFrames(workspace.walDirectoryPath, frames, { maxSegmentBytes: 2200 });

  const objectStore = memoryObjectStore();
  if (kind === "research") {
    const fileSystem = nodeCompactionFileSystem();
    const inventory = await inventoryWalRoot(fileSystem, workspace.walDirectoryPath);
    await extractResearchTier({ fileSystem, objectStore, clock: frozenClock(), byEpoch: inventory.byEpoch });
    return objectStore;
  }
  const datasetId = kind === "v1" ? FIXTURE_DATASET_ID : `${FIXTURE_DATASET_ID}-v2`;
  await compactWalDirectory({
    walDirectoryPath: workspace.walDirectoryPath,
    datasetId,
    objectKeyPrefix: `datasets/${datasetId}`,
    objectStore,
    fileSystem: nodeCompactionFileSystem(),
    clock: frozenClock(),
    incidentWindows: [FIXTURE_WINDOW],
    ...(kind === "v1" ? { datasetManifestVersion: 1 as const } : {}),
  });
  return objectStore;
}

describe("the Python validator's committed fixture", () => {
  it("is reproducible: two compactions of the same input agree byte for byte", async () => {
    const first = await buildFixture();
    await workspace.cleanup();
    workspace = await createWorkspace();
    const second = await buildFixture();

    expect(second.keys()).toStrictEqual(first.keys());
    for (const key of first.keys()) {
      expect(Buffer.from(await second.get(key))).toStrictEqual(
        Buffer.from(await first.get(key)),
      );
    }
  });

  it.each(["v1", "v2", "research"] as const)("matches the committed %s files under python/research/compaction/testdata", async (kind) => {
    const objectStore = await buildFixture(kind);
    const keys = objectStore.keys();
    expect(keys.length).toBeGreaterThan(2);

    if (UPDATE) {
      for (const key of keys) {
        const target = join(FIXTURE_ROOT, key);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, Buffer.from(await objectStore.get(key)));
      }
      return;
    }

    for (const key of keys) {
      const target = join(FIXTURE_ROOT, key);
      let committed: Buffer;
      try {
        committed = await readFile(target);
      } catch {
        throw new Error(
          `committed fixture is missing ${key}. Regenerate it with ` +
            "`pnpm --filter @polymarket-bot/research-worker fixture:python` and review the diff.",
        );
      }
      expect(
        Buffer.from(await objectStore.get(key)).equals(committed),
        `committed fixture ${key} no longer matches what the compactor produces. ` +
          "Regenerate it with `pnpm --filter @polymarket-bot/research-worker fixture:python` " +
          "and review the diff: a change to the bytes of an archive format must be deliberate.",
      ).toBe(true);
    }
  });

  it("exercises the cases the validator must survive", async () => {
    const objectStore = await buildFixture();
    const manifestBytes = await objectStore.get(`${FIXTURE_PREFIX}/manifest.json`);
    const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as {
      recordCounts: Record<string, number>;
      excludedIncidentWindows: unknown[];
      segments: unknown[];
    };

    expect(manifest.recordCounts["written"]).toBe(FIXTURE_FRAMES.length);
    expect(manifest.recordCounts["excludedByIncident"]).toBe(2);
    expect(manifest.recordCounts["replayEligible"]).toBe(FIXTURE_FRAMES.length - 2);
    expect(manifest.excludedIncidentWindows).toHaveLength(1);
    expect(manifest.segments.length).toBeGreaterThan(1);
  });
});

describe("the shared malformed manifests (ADR-017 §3; STORAGE-1 round 1, J3)", () => {
  // The same files `python/research/compaction/tests/test_storage1_versions.py`
  // refuses: the TypeScript and Python readers must agree on malformed bytes.
  it.each([
    "research-duplicate-fidelity.json",
    "research-invalid-utf8.json",
    "research-nan-literal.json",
    "research-lone-surrogate.json",
    "research-without-market-identities.json",
  ])("refuses %s", async (name) => {
    const bytes = await readFile(join(FIXTURE_ROOT, "malformed", name));
    expect(() => parseAnyDatasetManifest(parseStrictJsonBytes(bytes))).toThrow();
  });

  it("reads the unchanged research-tier manifest, as the Python reader does", async () => {
    const objectStore = await buildFixture("research");
    const key = objectStore.keys().find((candidate) => candidate.endsWith("/manifest.json"));
    if (key === undefined) throw new Error("no research manifest");
    const committed = await readFile(join(FIXTURE_ROOT, key));
    expect(parseAnyDatasetManifest(parseStrictJsonBytes(committed)).fidelity).toBe("approximate");
  });
});
