/**
 * The only modules in this package that touch a real disk.
 *
 * Everything else works through {@link CompactionFileSystem},
 * {@link ObjectStore}, and {@link WalSegmentRetention}, so a compaction run is
 * fully testable without a filesystem — and so the object-storage boundary can
 * be re-implemented against a real object store without touching the compactor.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { ObjectImmutabilityError } from "./errors.js";
import type {
  CompactionClock,
  CompactionFileSystem,
  ObjectHead,
  ObjectStore,
  SegmentDeletionRequest,
  WalSegmentRetention,
} from "./ports.js";
import { verifyRetentionProof } from "./retention-proof.js";
import { walManifestFileName, walSegmentFileName } from "./wal-format.js";

/** A `CompactionFileSystem` backed by `node:fs`. */
export function nodeCompactionFileSystem(): CompactionFileSystem {
  return {
    async listFileNames(directoryPath: string): Promise<readonly string[]> {
      try {
        return await readdir(directoryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return [];
        }
        throw error;
      }
    },
    async fileByteLength(path: string): Promise<number | null> {
      try {
        const stats = await stat(path);
        return stats.isFile() ? stats.size : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async readWholeFile(path: string): Promise<Uint8Array> {
      return await readFile(path);
    },
    joinPath(...segments: readonly string[]): string {
      return join(...segments);
    },
  };
}

/** A wall and monotonic clock backed by the host. */
export function systemCompactionClock(): CompactionClock {
  return {
    nowMs: () => Date.now(),
    monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  };
}

/** ISO-8601 instant with an explicit `Z` offset, from epoch milliseconds. */
export function isoFromEpochMs(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

function assertKeyIsRelative(key: string): void {
  if (key.length === 0) {
    throw new ObjectImmutabilityError("object key must not be empty", { key });
  }
  if (key.startsWith("/") || key.startsWith("\\") || /^[A-Za-z]:/u.test(key)) {
    throw new ObjectImmutabilityError("object key must be relative to the store root", { key });
  }
  for (const part of key.split(/[/\\]/u)) {
    if (part === ".." || part === ".") {
      throw new ObjectImmutabilityError("object key must not contain path traversal", { key });
    }
  }
}

/**
 * A filesystem-backed {@link ObjectStore}.
 *
 * Handoff §2 requires "checksummed Parquet in **object storage**" and names no
 * vendor. A local directory is a legitimate v1 object store — it is what the
 * integration suite uses, it needs no credential, and it makes the boundary
 * concrete before anyone chooses a cloud. A deployment that wants S3 or GCS
 * writes an adapter with the same three methods; nothing above this line
 * changes.
 *
 * Two properties the compactor depends on:
 *
 * - **`put` is atomic as observed through `get`.** Bytes go to a temporary file
 *   in the same directory, are fsynced, and are then renamed into place, so a
 *   crash mid-write cannot leave a truncated object under a real key. That is
 *   what makes a post-upload checksum comparison meaningful rather than a race.
 * - **`put` refuses to change an existing object.** Re-writing byte-identical
 *   content is a no-op (a re-run of the same compaction is idempotent);
 *   different content under a key something may already have pinned raises
 *   {@link ObjectImmutabilityError}. §12.5 has replay runs pin manifests, and a
 *   pinned artifact that can change underneath is not a pin.
 */
export function fileSystemObjectStore(rootDirectory: string): ObjectStore {
  const root = resolve(rootDirectory);

  const pathFor = (key: string): string => {
    assertKeyIsRelative(key);
    const target = resolve(root, key);
    if (target !== root && !target.startsWith(root + sep)) {
      throw new ObjectImmutabilityError("object key escapes the store root", { key });
    }
    return target;
  };

  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      const target = pathFor(key);
      const existing = await stat(target).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      });
      if (existing !== null) {
        const current = await readFile(target);
        const sameBytes =
          current.byteLength === bytes.byteLength &&
          createHash("sha256").update(current).digest("hex") ===
            createHash("sha256").update(bytes).digest("hex");
        if (sameBytes) {
          return;
        }
        throw new ObjectImmutabilityError(
          "object key already holds different bytes; datasets are immutable",
          { key, existingByteLength: current.byteLength, newByteLength: bytes.byteLength },
        );
      }

      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid.toString(36)}.${Date.now().toString(36)}.tmp`;
      const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT, 0o600);
      try {
        await handle.write(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, target);
    },

    async head(key: string): Promise<ObjectHead | null> {
      const target = pathFor(key);
      try {
        const stats = await stat(target);
        return stats.isFile() ? { byteLength: stats.size } : null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },

    async get(key: string): Promise<Uint8Array> {
      return await readFile(pathFor(key));
    },
  };
}

/**
 * Retention that deletes a WAL segment **after** its verified upload.
 *
 * This is the only code in the repository that removes a WAL file, and it is
 * deliberately narrow:
 *
 * - `packages/storage-wal` cannot delete: its filesystem port has no delete
 *   operation, and `docs/contracts/wal-format.md` §2 records that deletion
 *   belongs to `WP-130` "and only after a verified upload (ADR-004 §5)".
 * - **The request is treated as a set of claims, never as proof.** Before any
 *   unlink, {@link verifyRetentionProof} independently fetches the persisted
 *   dataset manifest and its digest sidecar from the object store, requires
 *   the manifest to pin this exact segment (checksum, record count, byte
 *   size, object key, object checksum), requires the segment file about to be
 *   deleted to hash to that pin, and requires the stored object to reproduce
 *   the file's frame lines byte for byte. A caller supplying an arbitrary
 *   object, its own digest, and a nonexistent manifest key — round-1 review's
 *   probe — is refused with `RetentionGuardError`.
 * - It removes the segment **and** its sidecar manifest, in that order. A
 *   manifest without a segment is a `SEGMENT_MISSING` refusal on the next run,
 *   which is a loud, correct state to crash into; a segment without a manifest
 *   is invisible to every compactor forever, which is a silent one.
 *
 * It is **not** the default. {@link retainAllWalSegments} is, and a deployment
 * opts into deletion.
 */
export function deleteAfterVerifiedUploadRetention(options: {
  readonly walDirectoryPath: string;
  readonly objectStore: ObjectStore;
  readonly fileSystem?: CompactionFileSystem;
}): WalSegmentRetention {
  const fileSystem = options.fileSystem ?? nodeCompactionFileSystem();
  return {
    policyName: "delete-after-verified-upload",
    async deleteSegment(request: SegmentDeletionRequest): Promise<void> {
      const segmentPath = fileSystem.joinPath(
        options.walDirectoryPath,
        walSegmentFileName(request.segmentId),
      );
      const manifestPath = fileSystem.joinPath(
        options.walDirectoryPath,
        walManifestFileName(request.segmentId),
      );

      await verifyRetentionProof(
        {
          objectStore: options.objectStore,
          readSegmentFile: () => fileSystem.readWholeFile(segmentPath),
        },
        request,
      );

      await rm(segmentPath, { force: true });
      await rm(manifestPath, { force: true });
    },
  };
}

/** Ensure a directory exists. Used by composition roots, not by the compactor. */
export async function ensureDirectory(directoryPath: string): Promise<void> {
  await mkdir(directoryPath, { recursive: true });
}

/** Write a whole file durably (temp file, fsync, rename). */
export async function writeWholeFileDurably(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid.toString(36)}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  const handle = await open(temporary, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}
