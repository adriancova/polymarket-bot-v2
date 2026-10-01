/**
 * Executing an expiry plan (`STORAGE-1`; ADR-028 Decision 4).
 *
 * Acceptance line pinned here: "The expiry plan is durable before any
 * deletion; the receipt is reporting, not proof."
 */

import { readFile, writeFile } from "node:fs/promises";
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
import { EXPIRY_PLAN_DIRECTORY, buildExpiryPlan, encodeExpiryPlan, executeExpiryPlan, listExpiryPlanIds } from "./execute.js";
import type { ExpiryPlan } from "./execute.js";
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
    inventory,
    objectStore: fixture.objectStore,
    windows: [],
    classifications: new Map(),
    operatorPins: [],
    pinSpecs: [],
    pinRecords: new Map(),
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
