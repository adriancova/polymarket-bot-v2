/**
 * Executing an expiry plan (ADR-028 Decision 4).
 *
 * The order is the whole point:
 *
 * 1. **The plan is made durable before anything is deleted** (Decision 4.5:
 *    "A crash between a deletion and its receipt must not lose the fact of
 *    the deletion. `STORAGE-1` persists the expiry plan before it deletes
 *    anything."). It is written to the state directory as a temporary file,
 *    `fsync`ed, LINKED to its final name (which refuses an existing plan of
 *    the same id: a durable plan is never replaced), the directory is
 *    `fsync`ed, and the plan is read back and compared byte for byte. A
 *    failure anywhere here deletes nothing.
 * 2. **Each planned segment is re-decided, then proved, then deleted, under
 *    the operator-pin lock** (`operator-pin-lock.ts`). The caller's `recheck`
 *    re-reads the operator's pins and the windows; the deletion capability
 *    runs the byte-level proof (`verifyExpiryProof`) on the exact bytes it
 *    unlinks; the caller's `finalCheck` re-reads the operator's pins once more,
 *    after the proof and immediately before the unlink. A pin published with
 *    the `storage pin` command is serialized with all of it. A failure keeps
 *    the segment and is reported; the next one is tried.
 * 3. **The receipt reports what happened**, version 2, with the
 *    `expired-after-extract` basis, naming the durable plan. It is reporting,
 *    not proof (ADR-017 §4): the proof was the verified manifests, and the
 *    plan already records the intent. A crash before the receipt loses only
 *    the report; a plan with no receipt is counted (`metrics.ts`), never read
 *    as "nothing was deleted".
 */

import { constants as fsConstants } from "node:fs";
import { link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
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
  parseStrictJsonBytes,
  sha256Hex,
} from "@polymarket-bot/storage-parquet";

import type { OperatorPinLock } from "./operator-pin-lock.js";
import { noOperatorPinLock } from "./operator-pin-lock.js";
import type { SegmentDecision } from "./plan.js";

/** The version of {@link ExpiryPlan}. */
export const EXPIRY_PLAN_VERSION = 1;

/** One planned deletion. */
export type ExpiryPlanEntry = {
  readonly walDirectoryPath: string;
  /** The segment's receipt span over its verified frames (the final operator-pin check covers it). */
  readonly minReceivedAt: string;
  readonly maxReceivedAt: string;
  /** Its length, for the WAL capacity metric once it is gone. */
  readonly byteSize: number;
  readonly request: ExpiryDeletionRequest;
};

/** The durable statement of what an expiry run is about to delete. */
export type ExpiryPlan = {
  readonly expiryPlanVersion: number;
  readonly planId: string;
  readonly createdAt: string;
  readonly retentionMs: number;
  readonly walRootPath: string;
  readonly entries: readonly ExpiryPlanEntry[];
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
      .filter(
        (decision) =>
          decision.eligible && decision.request !== null && decision.maxReceivedAt !== null && decision.minReceivedAt !== null,
      )
      .map((decision) => ({
        walDirectoryPath: decision.segment.walDirectoryPath,
        minReceivedAt: decision.minReceivedAt as string,
        maxReceivedAt: decision.maxReceivedAt as string,
        byteSize: decision.segment.byteSize,
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

/** A plan id that never repeats: the creation instant plus a random suffix. */
export function newExpiryPlanId(nowMs: number): string {
  const random = Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(6))).toString("hex");
  return `expiry-${new Date(nowMs).toISOString().replace(/[:.]/gu, "-")}-${random}`;
}

/** The file operations a durable plan needs; a test substitutes them to prove each one matters. */
export type PlanFileSystem = {
  mkdir(path: string): Promise<void>;
  /** Create a NEW file (`O_EXCL`). */
  createExclusive(path: string): Promise<{
    write(bytes: Uint8Array): Promise<void>;
    sync(): Promise<void>;
    close(): Promise<void>;
  }>;
  /** Give a file a second name; fails (`EEXIST`) when the name is taken. */
  link(existingPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
};

/** The real filesystem. */
export const nodePlanFileSystem: PlanFileSystem = {
  async mkdir(path) {
    await mkdir(path, { recursive: true });
  },
  async createExclusive(path) {
    const handle = await open(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    return {
      write: async (bytes) => {
        await handle.writeFile(bytes);
      },
      sync: async () => {
        await handle.sync();
      },
      close: async () => {
        await handle.close();
      },
    };
  },
  async link(existingPath, newPath) {
    await link(existingPath, newPath);
  },
  async unlink(path) {
    await unlink(path);
  },
  async syncDirectory(path) {
    const handle = await open(path, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async readFile(path) {
    return await readFile(path);
  },
};

/**
 * Write a plan durably and read it back. Returns its SHA-256. Throws — and
 * the caller deletes nothing — when the bytes are not durably the plan, or
 * when a plan of the same id already exists (it is never replaced).
 */
export async function persistExpiryPlan(
  stateDirectory: string,
  plan: ExpiryPlan,
  fileSystem: PlanFileSystem = nodePlanFileSystem,
): Promise<string> {
  const directory = join(stateDirectory, EXPIRY_PLAN_DIRECTORY);
  await fileSystem.mkdir(directory);
  const target = join(directory, `${plan.planId}.json`);
  const temporary = `${target}.${process.pid.toString(36)}.tmp`;
  const bytes = encodeExpiryPlan(plan);
  const handle = await fileSystem.createExclusive(temporary);
  try {
    await handle.write(bytes);
    // The plan's bytes reach the disk before it gets its name.
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // `link`, not `rename`: an existing plan of this id is refused, never replaced.
    await fileSystem.link(temporary, target);
  } catch (error) {
    await fileSystem.unlink(temporary).catch(() => undefined);
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ObjectVerificationError("an expiry plan with this id already exists; it is never replaced", { path: target });
    }
    throw error;
  }
  await fileSystem.unlink(temporary);
  // The new name reaches the disk before anything is deleted.
  await fileSystem.syncDirectory(directory);
  const stored = await fileSystem.readFile(target);
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

/** Read a durable plan's entries (strict JSON), for the capacity metric. */
export async function readExpiryPlanEntries(
  stateDirectory: string,
  planId: string,
): Promise<readonly { readonly gatewayEpoch: string; readonly segmentId: string; readonly byteSize: number }[]> {
  const value = parseStrictJsonBytes(await readFile(join(stateDirectory, EXPIRY_PLAN_DIRECTORY, `${planId}.json`)));
  const entries = (value as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error(`expiry plan ${planId} has no entries array`);
  return entries.map((raw) => {
    const entry = raw as { byteSize?: unknown; request?: { gatewayEpoch?: unknown; segmentId?: unknown } };
    const byteSize = entry.byteSize;
    const gatewayEpoch = entry.request?.gatewayEpoch;
    const segmentId = entry.request?.segmentId;
    if (typeof byteSize !== "number" || typeof gatewayEpoch !== "string" || typeof segmentId !== "string") {
      throw new Error(`expiry plan ${planId} has a malformed entry`);
    }
    return { gatewayEpoch, segmentId, byteSize };
  });
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
 * each under the operator-pin lock, then the receipt. `recheck` returns the
 * reasons a planned segment must now be kept (an empty list lets it go to the
 * guard); `finalCheck` throws when it must be kept, and runs after the proof,
 * immediately before the unlink.
 */
export async function executeExpiryPlan(input: {
  readonly plan: ExpiryPlan;
  readonly stateDirectory: string;
  readonly objectStore: ObjectStore;
  readonly deletion: ExpiredSegmentDeletion;
  readonly clock: CompactionClock;
  readonly recheck: (entry: ExpiryPlanEntry) => Promise<readonly string[]>;
  readonly finalCheck?: (entry: ExpiryPlanEntry) => Promise<void>;
  readonly lock?: OperatorPinLock;
  readonly planFileSystem?: PlanFileSystem;
}): Promise<ExpiryRunResult> {
  // -- 1. Durable before any deletion. -------------------------------------
  const planSha256 = await persistExpiryPlan(input.stateDirectory, input.plan, input.planFileSystem);
  const lock = input.lock ?? noOperatorPinLock();

  // -- 2. Re-decide, prove, delete: one segment at a time, under the lock. --
  const deleted: RetentionReceiptDeletion[] = [];
  const failures: RetentionReceiptFailure[] = [];
  let lockFailure: string | null = null;
  for (const entry of input.plan.entries) {
    if (lockFailure !== null) {
      failures.push({ segmentId: entry.request.segmentId, detail: `not attempted: ${lockFailure}` });
      continue;
    }
    try {
      await lock.withLock(async () => {
        const reasons = await input.recheck(entry);
        if (reasons.length > 0) {
          failures.push({ segmentId: entry.request.segmentId, detail: `kept on recheck: ${reasons.join("; ")}` });
          return;
        }
        try {
          const finalCheck = input.finalCheck;
          await input.deletion.deleteExpiredSegment(
            entry.walDirectoryPath,
            entry.request,
            finalCheck === undefined ? {} : { beforeUnlink: () => finalCheck(entry) },
          );
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
      });
    } catch (error) {
      // The lock could not be taken (or the recheck itself failed): keep
      // this segment and every one after it.
      lockFailure = error instanceof Error ? error.message : String(error);
      failures.push({ segmentId: entry.request.segmentId, detail: `kept: ${lockFailure}` });
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
