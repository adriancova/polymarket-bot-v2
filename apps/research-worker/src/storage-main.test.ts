/**
 * The storage command's composition root.
 *
 * - Round 2, K6: the timer and the `storage pin` command reach the
 *   operator-pin lock and file by their canonical path, however the
 *   configuration spells them.
 * - Round 5, N1: with no trader database configured, a trader window's rows
 *   are UNREADABLE, never an empty read — on the first invocation, after an
 *   outage, and in a dry run's report; a gateway-only deployment needs none.
 *
 * Real files in a temporary directory; the deletion runs only where the test
 * opted in.
 */

import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXPIRY_OPT_IN_MARKER_CONTENT,
  EXPIRY_OPT_IN_MARKER_FILE_NAME,
  expireAfterExtractDeletion,
  nodeCompactionFileSystem,
} from "@polymarket-bot/storage-parquet";

import type { MarketEvidence, TraderEvidenceSource } from "./retention/classify.js";
import { dispatchFrontier, staticEvidenceSource } from "./retention/classify.js";
import { runStorageCycle } from "./retention/cycle.js";
import type { StorageCycleDependencies } from "./retention/cycle.js";
import { EVIDENCE_HOLDS_FILE_NAME, readEvidenceHolds } from "./retention/evidence-holds.js";
import { loadOperatorPins } from "./retention/windows.js";
import type { MarketWindow } from "./retention/windows.js";
import { storageMain, storagePinMain } from "./storage-main.js";
import { EPOCH, HOUR, bookFrame, manualBootClock, storageFixture, tradeFrame } from "./testing/storage-fixture.js";
import type { StorageFixture } from "./testing/storage-fixture.js";

let fixture: StorageFixture | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fixture?.cleanup();
  fixture = null;
});

async function aliasedPinFile(root: string): Promise<{ target: string; alias: string }> {
  await mkdir(join(root, "real"));
  await mkdir(join(root, "alias"));
  const target = join(root, "real", "operator-pins.json");
  const alias = join(root, "alias", "operator-pins.json");
  await writeFile(target, JSON.stringify({ operatorPinVersion: 1, pins: [] }));
  await symlink(target, alias);
  return { target, alias };
}

describe("storageMain: the timer holds the lock beside the pin file's canonical path", () => {
  it("does not delete while the lock beside the canonical file is held, though the configuration names a symbolic link", async () => {
    const now = Date.now();
    fixture = await storageFixture({
      nowMs: now,
      segments: [[tradeFrame({ ingestSeq: "1", atMs: now - 80 * HOUR })], [tradeFrame({ ingestSeq: "2", atMs: now - HOUR })]],
    });
    await writeFile(join(fixture.walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const { target, alias } = await aliasedPinFile(fixture.root);
    const env: Record<string, string> = {
      RESEARCH_WORKER_WAL_ROOT: fixture.walRoot,
      RESEARCH_WORKER_OBJECT_STORE_ROOT: join(fixture.root, "objects"),
      RESEARCH_WORKER_STATE_DIR: fixture.stateDir,
      RESEARCH_WORKER_EXPIRY_MODE: "execute",
      RESEARCH_WORKER_EXTRACTION_BATCH_DELAY_MS: "0",
      RESEARCH_WORKER_OPERATOR_PINS: alias,
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    // A `storage pin` in flight holds the lock beside the canonical file.
    const lockPath = `${await realpath(target)}.lock`;
    await writeFile(lockPath, '{"pid":1,"acquiredAt":"2026-01-01T00:00:00.000Z"}\n');
    const held = await storageMain({ operatorPinLockTimeoutMs: 50 });
    expect(held).toBe(1);
    expect(printed.join("\n")).toContain(lockPath);
    const walFiles = async () => (await readdir(fixture?.walDir ?? "")).filter((name) => name.endsWith(".wal.jsonl"));
    expect(await walFiles()).toContain(fixture.segments[0]?.segmentFileName);
    // Control: once it is released, the old segment expires.
    await rm(lockPath);
    expect(await storageMain({ operatorPinLockTimeoutMs: 50 })).toBe(0);
    expect(await walFiles()).not.toContain(fixture.segments[0]?.segmentFileName);
  });
});

describe("storagePinMain: the command publishes to the canonical file", () => {
  it("writes the pin to the file a symbolic link names, and leaves the link in place", async () => {
    fixture = await storageFixture({ nowMs: Date.now(), segments: [] });
    const { target, alias } = await aliasedPinFile(fixture.root);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubEnv("RESEARCH_WORKER_OPERATOR_PINS", alias);
    const code = await storagePinMain(["incident-1", "2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z", "review"]);
    expect(code).toBe(0);
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect((await loadOperatorPins(target)).map((pin) => pin.pinId)).toStrictEqual(["incident-1"]);
  });
});

describe("N1 (round 5): with no trader database configured, a trader window's rows are unreadable, never an empty read", () => {
  // The round-5 reproduction: S0 holds the source (EPOCH, "2") of the window's
  // fill chain, a reference-feed frame two hours before the window and
  // outside every range the window could pin before its rows are read; S1 is
  // the window's own book; S2 is young.
  const MIN = 60 * 1000;
  type Setup = { f: StorageFixture; window: MarketWindow; registry: string; connected: TraderEvidenceSource };

  async function setup(responsibility: MarketWindow["responsibility"] = { kind: "trader", instanceIds: ["i"] }): Promise<Setup> {
    const now = Date.now();
    const start = now - 80 * HOUR;
    fixture = await storageFixture({
      nowMs: now,
      segments: [
        [tradeFrame({ ingestSeq: "1", atMs: start - 2 * HOUR })],
        [bookFrame({ ingestSeq: "3", atMs: start, tokenId: "tok", conditionId: "cond" })],
        [tradeFrame({ ingestSeq: "5", atMs: now - HOUR })],
      ],
    });
    await writeFile(join(fixture.walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const window: MarketWindow = {
      windowId: "w",
      marketId: "m",
      conditionId: "cond",
      gammaMarketId: null,
      tokenIds: ["tok"],
      windowStartMs: start,
      windowEndMs: start + 15 * MIN,
      responsibleFromMs: start,
      responsibility,
    };
    const registry = join(fixture.root, "windows.json");
    await writeFile(
      registry,
      JSON.stringify({
        windowRegistryVersion: 1,
        windows: [
          {
            windowId: window.windowId,
            marketId: window.marketId,
            conditionId: window.conditionId,
            tokenIds: window.tokenIds,
            windowStart: new Date(start).toISOString(),
            windowEnd: new Date(start + 15 * MIN).toISOString(),
            responsibleFrom: new Date(start).toISOString(),
            responsibility,
          },
        ],
      }),
    );
    const evidence: MarketEvidence = {
      fillsAtMs: [start + 1000],
      intents: [{ evaluatedAtMs: start, sourceEventId: "source", gatewayEpoch: EPOCH, ingestSeq: "2" }],
      refusalsAtMs: [],
      haltsAtMs: [],
    };
    const connected = staticEvidenceSource({ frontiers: new Map([["i", dispatchFrontier({ [EPOCH]: "1000" })]]), evidence: new Map([["m", evidence]]) });
    return { f: fixture, window, registry, connected };
  }

  /** The command's environment, with NO trader database URL. */
  function environment(setup: Setup, mode: "dry-run" | "execute"): void {
    for (const key of Object.keys(process.env)) if (key.startsWith("RESEARCH_WORKER_")) vi.stubEnv(key, undefined);
    const env: Record<string, string> = {
      RESEARCH_WORKER_WAL_ROOT: setup.f.walRoot,
      RESEARCH_WORKER_OBJECT_STORE_ROOT: join(setup.f.root, "objects"),
      RESEARCH_WORKER_STATE_DIR: setup.f.stateDir,
      RESEARCH_WORKER_WINDOW_REGISTRY: setup.registry,
      RESEARCH_WORKER_EXPIRY_MODE: mode,
      RESEARCH_WORKER_EXTRACTION_BATCH_DELAY_MS: "0",
    };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  }

  type Printed = { exit: number; report: { segments: { segmentId: string; eligible: boolean; reasons: string[] }[]; expiry: unknown; classifications: unknown[] } };
  async function runMain(): Promise<Printed> {
    const printed: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    const exit = await storageMain();
    spy.mockRestore();
    return { exit, report: JSON.parse(printed.at(-1) ?? "null") as Printed["report"] };
  }

  async function sourceOnDisk(setup: Setup): Promise<boolean> {
    return (await readdir(setup.f.walDir)).includes(setup.f.segments[0]?.segmentFileName ?? "");
  }

  function cycle(setup: Setup, evidence: TraderEvidenceSource): StorageCycleDependencies {
    return {
      walRootPath: setup.f.walRoot,
      objectStore: setup.f.objectStore,
      fileSystem: nodeCompactionFileSystem(),
      clock: setup.f.clock,
      evidence,
      loadWindows: async () => [setup.window],
      loadOperatorPins: async () => [],
      settings: {
        retentionMs: 72 * HOUR,
        leadInMs: 15 * MIN,
        durabilityGraceMs: 60_000,
        pinBudgetBytesPerDay: 1e12,
        expiryStuckAfterMs: 6 * HOUR,
        walMaxTotalBytes: null,
        maxSegmentsPerDataset: 64,
        extractionBatchDelayMs: 0,
      },
      mode: "execute",
      deletion: expireAfterExtractDeletion({ walRootPath: setup.f.walRoot, objectStore: setup.f.objectStore }),
      stateDirectory: setup.f.stateDir,
      bootClock: manualBootClock(),
    };
  }

  const unreadableReason = /^evidence-unreadable: w's rows could not be read and its evidence is not settled \(no trader database is configured/u;

  it("(execute, the first invocation) keeps the chain source's segment and every other, and marks the window's rows unreadable", async () => {
    const s = await setup();
    environment(s, "execute");
    const { exit, report } = await runMain();
    expect(exit).toBe(0);
    expect(await sourceOnDisk(s)).toBe(true);
    expect(await readdir(s.f.walDir)).toHaveLength(6);
    expect(report.expiry).toBeNull();
    expect(report.classifications).toStrictEqual([
      { windowId: "w", state: "unclassified", reason: expect.stringMatching(/no trader database is configured/u), evidenceUnreadable: true },
    ]);
    for (const segment of report.segments) {
      expect(segment.eligible).toBe(false);
      expect(segment.reasons).toContainEqual(expect.stringMatching(unreadableReason));
    }
    expect((await readEvidenceHolds(s.f.stateDir)).windows.get("w")).toStrictEqual({ holds: [], settled: false, unreadable: true });
  });

  it("(execute, after an outage) keeps the durable unreadable mark, and the chain source's segment", async () => {
    const s = await setup();
    const down: TraderEvidenceSource = {
      async dispatchFrontiers() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
      async marketEvidence() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
      },
    };
    await runStorageCycle(cycle(s, down));
    const marked = await readFile(join(s.f.stateDir, EVIDENCE_HOLDS_FILE_NAME));
    expect((await readEvidenceHolds(s.f.stateDir)).windows.get("w")).toStrictEqual({ holds: [], settled: false, unreadable: true });
    expect(await sourceOnDisk(s)).toBe(true);
    // The URL is then omitted.
    environment(s, "execute");
    const { exit, report } = await runMain();
    expect(exit).toBe(0);
    expect(await sourceOnDisk(s)).toBe(true);
    expect(report.expiry).toBeNull();
    for (const segment of report.segments) expect(segment.reasons).toContainEqual(expect.stringMatching(unreadableReason));
    expect(await readFile(join(s.f.stateDir, EVIDENCE_HOLDS_FILE_NAME))).toStrictEqual(marked);
  });

  it("(dry run) reports the same: every segment kept because the window's rows cannot be read; the mark is durable", async () => {
    const s = await setup();
    environment(s, "dry-run");
    const { exit, report } = await runMain();
    expect(exit).toBe(0);
    expect(report.expiry).toBeNull();
    for (const segment of report.segments) {
      expect(segment.eligible).toBe(false);
      expect(segment.reasons).toContainEqual(expect.stringMatching(unreadableReason));
    }
    expect(await readdir(s.f.walDir)).toHaveLength(6);
    // A dry run makes what it read durable too (round 5, N2): the next cycle keeps every segment even without the window.
    expect((await readEvidenceHolds(s.f.stateDir)).windows.get("w")).toStrictEqual({ holds: [], settled: false, unreadable: true });
  });

  it("control: with the database readable, the window's complete pin holds the source, and the source expires only under it", async () => {
    const s = await setup();
    const report = await runStorageCycle(cycle(s, s.connected));
    const outcome = report.pins[0];
    if (outcome === undefined || outcome.status !== "extracted") throw new Error("expected an extracted pin");
    expect(outcome.record.sourceEventsInside).toBe(true);
    const source = report.expiry?.deleted.find((entry) => entry.segmentId === s.f.segments[0]?.segmentId);
    if (source?.basis !== "expired-after-extract") throw new Error(`expected the source expired after extract, got ${JSON.stringify(source)}`);
    expect(source.pins.map((pin) => pin.pinId)).toStrictEqual([outcome.pinId]);
  });

  it("control: a gateway-only deployment needs no database; its old segments expire", async () => {
    const s = await setup({ kind: "gateway-only" });
    environment(s, "execute");
    const { exit, report } = await runMain();
    expect(exit).toBe(0);
    expect(report.classifications).toStrictEqual([{ windowId: "w", state: "classified", pinClass: null, evidenceCounts: { fills: 0, intents: 0, refusals: 0, halts: 0 } }]);
    expect(await sourceOnDisk(s)).toBe(false);
    expect(report.segments.find((segment) => segment.segmentId === s.f.segments[0]?.segmentId)).toMatchObject({ eligible: true, reasons: [] });
  });
});
