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
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { ObjectImmutabilityError, RetentionGuardError } from "./errors.js";
import { verifyExpiryProof } from "./expiry-proof.js";
import type { ExpiryDeletionRequest, ExpiryProofOutcome } from "./expiry-proof.js";
import type {
  CompactionClock,
  CompactionFileSystem,
  ExpiredSegmentDeletion,
  ExpiredSegmentDeletionOptions,
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
 *   size, whole-file digest, object key, object checksum), requires the
 *   segment file about to be deleted to hash to those pins — including the
 *   whole-file `segmentFileSha256`, which is what covers the footer the WAL
 *   span digest cannot — and requires the stored object to reproduce the
 *   file's frame lines byte for byte. A caller supplying an arbitrary
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

/**
 * The file an operator creates in a WAL root to permit expiry there.
 *
 * Raw-WAL expiry deletes evidence that is not all kept anywhere else (ADR-028
 * Decision 4.2), so it must be **impossible to point at a directory by
 * default**: a WAL root without this file, holding exactly
 * {@link EXPIRY_OPT_IN_MARKER_CONTENT}, refuses every deletion, whatever the
 * caller's configuration says. Creating it is a deliberate operator act on
 * the one host directory that should expire (`docs/handoffs/STORAGE-1.md`).
 */
export const EXPIRY_OPT_IN_MARKER_FILE_NAME = ".polymarket-bot-raw-wal-expiry-opt-in";

/** The exact content of {@link EXPIRY_OPT_IN_MARKER_FILE_NAME}. */
export const EXPIRY_OPT_IN_MARKER_CONTENT =
  "polymarket-bot: raw WAL in this directory may expire after a verified extract (ADR-028).\n";

/** Whether `walRootPath` holds a valid expiry opt-in marker. */
export async function hasExpiryOptInMarker(walRootPath: string): Promise<boolean> {
  try {
    const content = await readFile(join(walRootPath, EXPIRY_OPT_IN_MARKER_FILE_NAME), "utf8");
    return content === EXPIRY_OPT_IN_MARKER_CONTENT;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Deletion under ADR-028's expired-after-extract basis, against a real disk.
 *
 * Three guards, all re-checked on every call:
 *
 * 1. **The WAL root opted in.** {@link EXPIRY_OPT_IN_MARKER_FILE_NAME} must
 *    exist in `walRootPath` with its exact content; otherwise nothing is
 *    deleted (`RetentionGuardError`).
 * 2. **The directory is inside that root.** A request cannot reach a path the
 *    capability was not granted.
 * 3. **The proof holds for the bytes about to go** ({@link verifyExpiryProof}):
 *    the research tier and every named pin verified from the store, and the
 *    file hashing to both digests they pin.
 * 4. **The caller's final check** (`options.beforeUnlink`) runs after the
 *    proof and immediately before the unlink, so a condition that can change
 *    while the proof reads the store (an operator pin) is re-read last.
 *
 * Then it removes the segment and its sidecar manifest, in that order (the
 * reasoning on {@link deleteAfterVerifiedUploadRetention}). A crash between
 * the two leaves a sidecar with no segment, which the research worker's
 * inventory reports as an orphan and never plans again.
 */
export function expireAfterExtractDeletion(options: {
  readonly walRootPath: string;
  readonly objectStore: ObjectStore;
  readonly fileSystem?: CompactionFileSystem;
}): ExpiredSegmentDeletion {
  const fileSystem = options.fileSystem ?? nodeCompactionFileSystem();
  return {
    policyName: "expire-after-extract",
    async deleteExpiredSegment(
      walDirectoryPath: string,
      request: ExpiryDeletionRequest,
      deletionOptions?: ExpiredSegmentDeletionOptions,
    ): Promise<ExpiryProofOutcome> {
      // Real paths, so a symbolic link cannot carry a deletion out of the root.
      const root = await realpath(options.walRootPath).catch(() => resolve(options.walRootPath));
      if (!(await hasExpiryOptInMarker(root))) {
        throw new RetentionGuardError(
          "refusing to expire a WAL segment: the WAL root has not opted in to expiry",
          { walRootPath: root, marker: EXPIRY_OPT_IN_MARKER_FILE_NAME, segmentId: request.segmentId },
        );
      }
      const directory = await realpath(walDirectoryPath).catch(() => resolve(walDirectoryPath));
      if (directory !== root && !directory.startsWith(root + sep)) {
        throw new RetentionGuardError(
          "refusing to expire a WAL segment: its directory is outside the opted-in WAL root",
          { walRootPath: root, walDirectoryPath: directory, segmentId: request.segmentId },
        );
      }
      const segmentPath = fileSystem.joinPath(directory, walSegmentFileName(request.segmentId));
      const manifestPath = fileSystem.joinPath(directory, walManifestFileName(request.segmentId));
      const outcome = await verifyExpiryProof(
        { objectStore: options.objectStore, readSegmentFile: () => fileSystem.readWholeFile(segmentPath) },
        request,
      );
      if (deletionOptions?.beforeUnlink !== undefined) {
        try {
          await deletionOptions.beforeUnlink();
        } catch (error) {
          throw new RetentionGuardError(
            `refusing to expire a WAL segment: the final check before the unlink failed: ${error instanceof Error ? error.message : String(error)}`,
            { segmentId: request.segmentId },
          );
        }
      }
      await rm(segmentPath, { force: true });
      await rm(manifestPath, { force: true });
      return outcome;
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
