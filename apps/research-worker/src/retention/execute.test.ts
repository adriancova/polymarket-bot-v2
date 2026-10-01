/**
 * Executing an expiry plan (`STORAGE-1`; ADR-028 Decision 4).
 *
 * Acceptance line pinned here: "The expiry plan is durable before any
 * deletion; the receipt is reporting, not proof."
 */

import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ExpiredSegmentDeletion, ExpiryDeletionRequest } from "@polymarket-bot/storage-parquet";
import {
  EXPIRY_OPT_IN_MARKER_CONTENT,
  EXPIRY_OPT_IN_MARKER_FILE_NAME,
  expireAfterExtractDeletion,
  parseRetentionReceipt,
  sha256Hex,
} from "@polymarket-bot/storage-parquet";

import { HOUR, storageFixture, tradeFrame } from "../testing/storage-fixture.js";
import type { StorageFixture } from "../testing/storage-fixture.js";
import {
  EXPIRY_PLAN_DIRECTORY,
  buildExpiryPlan,
  encodeExpiryPlan,
  executeExpiryPlan,
  listExpiryPlanIds,
  newExpiryPlanId,
  nodePlanFileSystem,
  persistExpiryPlan,
} from "./execute.js";
import type { ExpiryPlan, PlanFileSystem } from "./execute.js";
import type { OperatorPinLock } from "./operator-pin-lock.js";
import { emptyEvidenceHolds } from "./evidence-holds.js";
import { readExtractedPins } from "./pins.js";
import { RAW_RETENTION_MS, planExpiry } from "./plan.js";

const NOW = Date.parse("2026-01-10T00:00:00.000Z");

let fixture: StorageFixture | null = null;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = null;
});

async function eligiblePlan(): Promise<{ fixture: StorageFixture; plan: ExpiryPlan }> {
  fixture = await storageFixture({
    nowMs: NOW,
    segments: [[tradeFrame({ ingestSeq: "1", atMs: NOW - 80 * HOUR })], [tradeFrame({ ingestSeq: "2", atMs: NOW - 1 * HOUR })]],
  });
  const inventory = await fixture.extract();
  const decisions = await planExpiry({
    nowMs: NOW,
    retentionMs: RAW_RETENTION_MS,
    leadInMs: 0,
    durabilityGraceMs: 0,
    inventory,
    objectStore: fixture.objectStore,
    windows: [],
    classifications: new Map(),
    operatorPins: [],
    pinSpecs: [],
    pinRecords: new Map(),
    extractedPins: await readExtractedPins(fixture.objectStore),
    evidenceHolds: emptyEvidenceHolds(),
  });
  const plan = buildExpiryPlan({ planId: "plan-1", nowMs: NOW, retentionMs: RAW_RETENTION_MS, walRootPath: fixture.walRoot, decisions });
  expect(plan.entries).toHaveLength(1);
  return { fixture, plan };
}

describe("the expiry plan is durable before any deletion", () => {
  it("writes the plan, reads it back, and only then calls the deletion", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    const planPath = join(f.stateDir, EXPIRY_PLAN_DIRECTORY, "plan-1.json");
    const real = expireAfterExtractDeletion({ walRootPath: f.walRoot, objectStore: f.objectStore });
    await writeFile(join(f.walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const observed: string[] = [];
    const deletion: ExpiredSegmentDeletion = {
      policyName: real.policyName,
      async deleteExpiredSegment(directory: string, request: ExpiryDeletionRequest) {
        // At the moment of the first deletion, the plan is on disk, whole.
        observed.push(sha256Hex(await readFile(planPath)));
        return await real.deleteExpiredSegment(directory, request);
      },
    };
    const result = await executeExpiryPlan({
      plan,
      stateDirectory: f.stateDir,
      objectStore: f.objectStore,
      deletion,
      clock: f.clock,
      recheck: async () => [],
    });
    expect(observed).toStrictEqual([sha256Hex(encodeExpiryPlan(plan))]);
    expect(result.planSha256).toBe(observed[0]);
    expect(result.deleted.map((deletion_) => deletion_.segmentId)).toStrictEqual([plan.entries[0]?.request.segmentId]);
    expect(await listExpiryPlanIds(f.stateDir)).toStrictEqual(["plan-1"]);
  });

  it("deletes nothing when the plan cannot be made durable", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    // The state directory is a FILE: the plan cannot be written.
    await writeFile(f.stateDir, "not a directory");
    let called = 0;
    const deletion: ExpiredSegmentDeletion = {
      policyName: "expire-after-extract",
      async deleteExpiredSegment() {
        called += 1;
        throw new Error("must not be reached");
      },
    };
    await expect(
      executeExpiryPlan({ plan, stateDirectory: f.stateDir, objectStore: f.objectStore, deletion, clock: f.clock, recheck: async () => [] }),
    ).rejects.toThrow();
    expect(called).toBe(0);
  });

  it("keeps a planned segment that a fresh recheck now holds, and reports it", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    let called = 0;
    const deletion: ExpiredSegmentDeletion = {
      policyName: "expire-after-extract",
      async deleteExpiredSegment() {
        called += 1;
        throw new Error("must not be reached");
      },
    };
    const result = await executeExpiryPlan({
      plan,
      stateDirectory: f.stateDir,
      objectStore: f.objectStore,
      deletion,
      clock: f.clock,
      recheck: async () => ["operator-pin: operator-new"],
    });
    expect(called).toBe(0);
    expect(result.deleted).toStrictEqual([]);
    expect(result.failures[0]?.detail).toMatch(/kept on recheck: operator-pin/u);
  });
});

describe("the receipt is version 2 reporting with the expired-after-extract basis", () => {
  it("names the durable plan, the research tier and the pins, and reads back", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    await writeFile(join(f.walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const result = await executeExpiryPlan({
      plan,
      stateDirectory: f.stateDir,
      objectStore: f.objectStore,
      deletion: expireAfterExtractDeletion({ walRootPath: f.walRoot, objectStore: f.objectStore }),
      clock: f.clock,
      recheck: async () => [],
    });
    const receipt = parseRetentionReceipt(JSON.parse(Buffer.from(await f.objectStore.get(result.receiptObjectKey)).toString("utf8")));
    expect(receipt.retentionReceiptVersion).toBe(2);
    expect(receipt.expiryPlanId).toBe("plan-1");
    expect(receipt.expiryPlanSha256).toBe(result.planSha256);
    expect(receipt.datasetId).toBeNull();
    const [entry] = receipt.deletedSegments;
    expect(entry?.basis).toBe("expired-after-extract");
    if (entry?.basis !== "expired-after-extract") throw new Error("wrong basis");
    expect(entry.researchTier.manifestObjectKey).toBe(plan.entries[0]?.request.researchTier.manifestObjectKey);
    expect(entry.segmentFileSha256).toBe(plan.entries[0]?.request.segmentFileSha256);
    expect(entry.pins).toStrictEqual([]);
  });

  it("reports a deletion the guard refused as a failure, and keeps the file", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    // No opt-in marker: the real deletion refuses.
    const result = await executeExpiryPlan({
      plan,
      stateDirectory: f.stateDir,
      objectStore: f.objectStore,
      deletion: expireAfterExtractDeletion({ walRootPath: f.walRoot, objectStore: f.objectStore }),
      clock: f.clock,
      recheck: async () => [],
    });
    expect(result.deleted).toStrictEqual([]);
    expect(result.failures[0]?.detail).toMatch(/has not opted in/u);
    const segment = f.segments[0];
    if (segment === undefined) throw new Error("no segment");
    expect((await readFile(join(f.walDir, segment.segmentFileName))).byteLength).toBe(segment.segmentBytes.byteLength);
  });
});

/** The real plan filesystem, recording each operation, with one fault on demand. */
function recordingPlanFileSystem(
  ops: string[],
  fault: "file-sync" | "dir-sync" | "read-back" | null = null,
): PlanFileSystem {
  return {
    async mkdir(path) {
      ops.push("mkdir");
      await nodePlanFileSystem.mkdir(path);
    },
    async createExclusive(path) {
      ops.push("create");
      const handle = await nodePlanFileSystem.createExclusive(path);
      return {
        write: async (bytes) => {
          ops.push("write");
          await handle.write(bytes);
        },
        sync: async () => {
          ops.push("file-sync");
          if (fault === "file-sync") throw new Error("EIO: the file sync failed");
          await handle.sync();
        },
        close: async () => {
          ops.push("close");
          await handle.close();
        },
      };
    },
    async link(existingPath, newPath) {
      ops.push("link");
      await nodePlanFileSystem.link(existingPath, newPath);
    },
    async unlink(path) {
      ops.push("unlink");
      await nodePlanFileSystem.unlink(path);
    },
    async syncDirectory(path) {
      ops.push("dir-sync");
      if (fault === "dir-sync") throw new Error("EIO: the directory sync failed");
      await nodePlanFileSystem.syncDirectory(path);
    },
    async readFile(path) {
      ops.push("read-back");
      const bytes = await nodePlanFileSystem.readFile(path);
      return fault === "read-back" ? Buffer.concat([Buffer.from(bytes), Buffer.from(" ")]) : bytes;
    },
  };
}

function spyDeletion(ops: string[]): ExpiredSegmentDeletion & { calls: number } {
  const spy = {
    policyName: "expire-after-extract",
    calls: 0,
    async deleteExpiredSegment(): Promise<never> {
      spy.calls += 1;
      ops.push("delete");
      throw new Error("the spy deletes nothing");
    },
  };
  return spy;
}

describe("acceptance 11, operation by operation: the plan's bytes and name are durable before the first deletion (J4)", () => {
  it("fsyncs the plan file, links it, fsyncs the directory and reads it back, all before any deletion", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    const ops: string[] = [];
    await executeExpiryPlan({
      plan,
      stateDirectory: f.stateDir,
      objectStore: f.objectStore,
      deletion: spyDeletion(ops),
      clock: f.clock,
      recheck: async () => [],
      planFileSystem: recordingPlanFileSystem(ops),
    });
    expect(ops).toStrictEqual(["mkdir", "create", "write", "file-sync", "close", "link", "unlink", "dir-sync", "read-back", "delete"]);
  });

  it.each(["file-sync", "dir-sync", "read-back"] as const)("deletes nothing when the %s step fails", async (fault) => {
    const { fixture: f, plan } = await eligiblePlan();
    const ops: string[] = [];
    const deletion = spyDeletion(ops);
    await expect(
      executeExpiryPlan({
        plan,
        stateDirectory: f.stateDir,
        objectStore: f.objectStore,
        deletion,
        clock: f.clock,
        recheck: async () => [],
        planFileSystem: recordingPlanFileSystem(ops, fault),
      }),
    ).rejects.toThrow(fault === "read-back" ? /did not read back as written/u : /EIO/u);
    expect(deletion.calls).toBe(0);
    expect(ops).not.toContain("delete");
    const segment = f.segments[0];
    if (segment === undefined) throw new Error("no segment");
    expect((await readFile(join(f.walDir, segment.segmentFileName))).byteLength).toBe(segment.segmentBytes.byteLength);
  });
});

describe("a durable plan is never replaced (J15)", () => {
  it("refuses a second plan under the same id, leaves the first intact, and deletes nothing", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    await persistExpiryPlan(f.stateDir, plan);
    const first = await readFile(join(f.stateDir, EXPIRY_PLAN_DIRECTORY, "plan-1.json"));
    const other: ExpiryPlan = { ...plan, createdAt: "2026-01-10T00:00:00.001Z" };
    const ops: string[] = [];
    const deletion = spyDeletion(ops);
    await expect(
      executeExpiryPlan({ plan: other, stateDirectory: f.stateDir, objectStore: f.objectStore, deletion, clock: f.clock, recheck: async () => [] }),
    ).rejects.toThrow(/already exists; it is never replaced/u);
    expect(deletion.calls).toBe(0);
    expect(await readFile(join(f.stateDir, EXPIRY_PLAN_DIRECTORY, "plan-1.json"))).toStrictEqual(first);
    // No temporary file is left behind.
    expect(await readdir(join(f.stateDir, EXPIRY_PLAN_DIRECTORY))).toStrictEqual(["plan-1.json"]);
  });

  it("names every plan with the instant and a random suffix", () => {
    const one = newExpiryPlanId(NOW);
    const two = newExpiryPlanId(NOW);
    expect(one).toMatch(/^expiry-2026-01-10T00-00-00-000Z-[0-9a-f]{12}$/u);
    expect(one).not.toBe(two);
  });
});

describe("the final decision and the unlink happen under the operator-pin lock (J6)", () => {
  it("holds the lock from the recheck through the unlink, and runs the final check after the proof", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    await writeFile(join(f.walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const ops: string[] = [];
    const lock: OperatorPinLock = {
      async withLock(work) {
        ops.push("lock");
        try {
          return await work();
        } finally {
          ops.push("unlock");
        }
      },
    };
    const real = expireAfterExtractDeletion({ walRootPath: f.walRoot, objectStore: f.objectStore });
    const deletion: ExpiredSegmentDeletion = {
      policyName: real.policyName,
      async deleteExpiredSegment(directory, request, options) {
        ops.push("proof-and-unlink");
        const outcome = await real.deleteExpiredSegment(directory, request, options);
        ops.push("unlinked");
        return outcome;
      },
    };
    const result = await executeExpiryPlan({
      plan,
      stateDirectory: f.stateDir,
      objectStore: f.objectStore,
      deletion,
      clock: f.clock,
      lock,
      recheck: async () => {
        ops.push("recheck");
        return [];
      },
      finalCheck: async () => {
        ops.push("final-check");
      },
    });
    expect(result.deleted).toHaveLength(1);
    expect(ops).toStrictEqual(["lock", "recheck", "proof-and-unlink", "final-check", "unlinked", "unlock"]);
  });

  it("keeps the segment when the final check refuses", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    await writeFile(join(f.walRoot, EXPIRY_OPT_IN_MARKER_FILE_NAME), EXPIRY_OPT_IN_MARKER_CONTENT);
    const result = await executeExpiryPlan({
      plan,
      stateDirectory: f.stateDir,
      objectStore: f.objectStore,
      deletion: expireAfterExtractDeletion({ walRootPath: f.walRoot, objectStore: f.objectStore }),
      clock: f.clock,
      recheck: async () => [],
      finalCheck: async () => {
        throw new Error("operator pin late now covers the segment");
      },
    });
    expect(result.deleted).toStrictEqual([]);
    expect(result.failures[0]?.detail).toMatch(/final check before the unlink failed: operator pin late/u);
    const segment = f.segments[0];
    if (segment === undefined) throw new Error("no segment");
    expect((await readFile(join(f.walDir, segment.segmentFileName))).byteLength).toBe(segment.segmentBytes.byteLength);
  });

  it("deletes nothing more once the lock cannot be taken", async () => {
    const { fixture: f, plan } = await eligiblePlan();
    const ops: string[] = [];
    const deletion = spyDeletion(ops);
    const result = await executeExpiryPlan({
      plan,
      stateDirectory: f.stateDir,
      objectStore: f.objectStore,
      deletion,
      clock: f.clock,
      lock: {
        withLock: async () => {
          throw new Error("the operator-pin lock is held");
        },
      },
      recheck: async () => [],
    });
    expect(deletion.calls).toBe(0);
    expect(result.failures[0]?.detail).toMatch(/kept: the operator-pin lock is held/u);
  });
});
