/**
 * Executing an expiry plan (ADR-028 Decision 4).
 *
 * The order is the whole point:
 *
 * 1. **The plan is made durable before anything is deleted** (Decision 4.5:
 *    "A crash between a deletion and its receipt must not lose the fact of
 *    the deletion. `STORAGE-1` persists the expiry plan before it deletes
 *    anything."). It is written to the state directory with a temporary file,
 *    `fsync`, an atomic rename and an `fsync` of the directory, then read back
 *    and compared byte for byte. A failure anywhere here deletes nothing.
 * 2. **Each planned segment is re-decided, then proved, then deleted.** The
 *    caller's `recheck` re-reads the operator's pins and the windows right
 *    before the deletion, so a pin added after planning still holds; the
 *    deletion capability then runs the byte-level proof
 *    (`verifyExpiryProof`) on the exact bytes it unlinks. A failure keeps the
 *    segment and is reported; the next one is tried.
 * 3. **The receipt reports what happened**, version 2, with the
 *    `expired-after-extract` basis, naming the durable plan. It is reporting,
 *    not proof (ADR-017 §4): the proof was the verified manifests, and the
 *    plan already records the intent. A crash before the receipt loses only
 *    the report; a plan with no receipt is counted (`metrics.ts`), never read
 *    as "nothing was deleted".
 */

import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

import type {
  CompactionClock,
  ExpiredSegmentDeletion,
  ExpiryDeletionRequest,
  ObjectStore,
  RetentionReceiptDeletion,
  RetentionReceiptFailure,
} from "@polymarket-bot/storage-parquet";
import {
  DATASET_RETENTION_RECEIPT_OBJECT_NAME,
  ObjectVerificationError,
  buildRetentionReceipt,
  encodeRetentionReceipt,
  sha256Hex,
} from "@polymarket-bot/storage-parquet";

import type { SegmentDecision } from "./plan.js";

/** The version of {@link ExpiryPlan}. */
export const EXPIRY_PLAN_VERSION = 1;

/** The durable statement of what an expiry run is about to delete. */
export type ExpiryPlan = {
  readonly expiryPlanVersion: number;
  readonly planId: string;
  readonly createdAt: string;
  readonly retentionMs: number;
  readonly walRootPath: string;
  readonly entries: readonly {
    readonly walDirectoryPath: string;
    readonly maxReceivedAt: string;
    readonly request: ExpiryDeletionRequest;
  }[];
};

/** Build a plan from the planner's decisions: only the eligible segments. */
export function buildExpiryPlan(input: {
  readonly planId: string;
  readonly nowMs: number;
  readonly retentionMs: number;
  readonly walRootPath: string;
  readonly decisions: readonly SegmentDecision[];
}): ExpiryPlan {
  return {
    expiryPlanVersion: EXPIRY_PLAN_VERSION,
    planId: input.planId,
    createdAt: new Date(input.nowMs).toISOString(),
    retentionMs: input.retentionMs,
    walRootPath: input.walRootPath,
    entries: input.decisions
      .filter((decision) => decision.eligible && decision.request !== null && decision.maxReceivedAt !== null)
      .map((decision) => ({
        walDirectoryPath: decision.segment.walDirectoryPath,
        maxReceivedAt: decision.maxReceivedAt as string,
        request: decision.request as ExpiryDeletionRequest,
      })),
  };
}

/** The canonical bytes of a plan. */
export function encodeExpiryPlan(plan: ExpiryPlan): Uint8Array {
  return Buffer.from(`${JSON.stringify(plan, null, 2)}\n`, "utf8");
}

/** The directory, under the state directory, holding the durable plans. */
export const EXPIRY_PLAN_DIRECTORY = "expiry-plans";

/** The object key of a plan's receipt. */
export function expiryReceiptKey(planId: string): string {
  return `expiry/${planId}/${DATASET_RETENTION_RECEIPT_OBJECT_NAME}`;
}

/**
 * Write a plan durably and read it back. Returns its SHA-256. Throws — and
 * the caller deletes nothing — when the bytes on disk are not the plan.
 */
export async function persistExpiryPlan(stateDirectory: string, plan: ExpiryPlan): Promise<string> {
  const directory = join(stateDirectory, EXPIRY_PLAN_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${plan.planId}.json`);
  const temporary = `${target}.${process.pid.toString(36)}.tmp`;
  const bytes = encodeExpiryPlan(plan);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  const directoryHandle = await open(directory, fsConstants.O_RDONLY);
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
  const stored = await readFile(target);
  const expected = sha256Hex(bytes);
  if (sha256Hex(stored) !== expected) {
    throw new ObjectVerificationError("the expiry plan did not read back as written", { path: target });
  }
  return expected;
}

/** Every durable plan id in the state directory. */
export async function listExpiryPlanIds(stateDirectory: string): Promise<readonly string[]> {
  try {
    return (await readdir(join(stateDirectory, EXPIRY_PLAN_DIRECTORY)))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -".json".length))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** What an execution did. */
export type ExpiryRunResult = {
  readonly planId: string;
  readonly planSha256: string;
  readonly deleted: readonly RetentionReceiptDeletion[];
  readonly failures: readonly RetentionReceiptFailure[];
  readonly receiptObjectKey: string;
  readonly receiptSha256: string;
};

/**
 * Execute a plan: durable plan first, then one proved deletion at a time,
 * then the receipt. `recheck` returns the reasons a planned segment must now
 * be kept (an empty list lets it go to the guard).
 */
export async function executeExpiryPlan(input: {
  readonly plan: ExpiryPlan;
  readonly stateDirectory: string;
  readonly objectStore: ObjectStore;
  readonly deletion: ExpiredSegmentDeletion;
  readonly clock: CompactionClock;
  readonly recheck: (entry: ExpiryPlan["entries"][number]) => Promise<readonly string[]>;
}): Promise<ExpiryRunResult> {
  // -- 1. Durable before any deletion. -------------------------------------
  const planSha256 = await persistExpiryPlan(input.stateDirectory, input.plan);

  // -- 2. Re-decide, prove, delete: one segment at a time. -----------------
  const deleted: RetentionReceiptDeletion[] = [];
  const failures: RetentionReceiptFailure[] = [];
  for (const entry of input.plan.entries) {
    const reasons = await input.recheck(entry);
    if (reasons.length > 0) {
      failures.push({ segmentId: entry.request.segmentId, detail: `kept on recheck: ${reasons.join("; ")}` });
      continue;
    }
    try {
      await input.deletion.deleteExpiredSegment(entry.walDirectoryPath, entry.request);
      deleted.push({
        basis: "expired-after-extract",
        segmentId: entry.request.segmentId,
        gatewayEpoch: entry.request.gatewayEpoch,
        segmentSha256: entry.request.segmentSha256,
        segmentFileSha256: entry.request.segmentFileSha256,
        researchTier: entry.request.researchTier,
        pins: entry.request.pins,
      });
    } catch (error) {
      failures.push({
        segmentId: entry.request.segmentId,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // -- 3. The receipt: reporting, not proof. --------------------------------
  const receipt = buildRetentionReceipt({
    datasetId: null,
    datasetManifestObjectKey: null,
    datasetManifestSha256: null,
    expiryPlanId: input.plan.planId,
    expiryPlanSha256: planSha256,
    walRetentionPolicy: input.deletion.policyName,
    completedAt: new Date(input.clock.nowMs()).toISOString(),
    deletedSegments: deleted,
    retentionFailures: failures,
  });
  const receiptBytes = encodeRetentionReceipt(receipt);
  const receiptObjectKey = expiryReceiptKey(input.plan.planId);
  await input.objectStore.put(receiptObjectKey, receiptBytes);
  const receiptSha256 = sha256Hex(receiptBytes);
  if (sha256Hex(await input.objectStore.get(receiptObjectKey)) !== receiptSha256) {
    throw new ObjectVerificationError("the expiry receipt read back with a different digest", { receiptObjectKey });
  }
  return { planId: input.plan.planId, planSha256, deleted, failures, receiptObjectKey, receiptSha256 };
}
