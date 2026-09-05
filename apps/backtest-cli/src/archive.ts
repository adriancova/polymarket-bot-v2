/**
 * The filesystem archive adapter and the SHA-256 digest port.
 *
 * `apps/backtest-cli` is a layer-3 composition root
 * (`docs/contracts/dependency-direction.md` §2), so it is the correct place —
 * and the only permitted place — for `node:fs`, `node:crypto`, and the layer-2
 * `@polymarket-bot/storage-parquet` reader. `packages/simulation` is layer 1 and
 * takes all three as ports.
 *
 * The reader deliberately performs NO verification. `loadDataset` digests the
 * bytes this returns and compares them with the manifest's own pins, so the
 * component that reads the bytes is never the component that decides they are
 * acceptable.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

import { readParquetObject } from "@polymarket-bot/storage-parquet";
import type { ArchivedObject, DatasetArchiveReader, Sha256HexDigest } from "@polymarket-bot/simulation";

/** SHA-256 as lowercase hex. The port `packages/simulation` cannot provide itself. */
export const sha256Hex: Sha256HexDigest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Resolves an object key beneath a root directory, refusing traversal.
 *
 * The object keys come from a manifest, which is data this process reads rather
 * than data it wrote in this run. A key of `../../etc/shadow` must not resolve
 * outside the dataset root.
 */
export function resolveWithinRoot(root: string, key: string): string {
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, normalize(key));
  if (candidate !== rootPath && !candidate.startsWith(rootPath + sep)) {
    throw new Error(`object key ${JSON.stringify(key)} resolves outside the dataset root`);
  }
  return candidate;
}

/** Reads dataset objects from a directory laid out by object key. */
export function fileSystemArchiveReader(rootDirectory: string): DatasetArchiveReader {
  return {
    async readObject(objectKey: string): Promise<ArchivedObject> {
      const path = resolveWithinRoot(rootDirectory, objectKey);
      const buffer = await readFile(path);
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
      const rows = await readParquetObject(bytes);
      return { objectKey, bytes, rows };
    },
  };
}

/** Reads WAL segment files, when they still exist, for whole-file verification. */
export function fileSystemWalSegmentReader(
  rootDirectory: string,
  fileNameFor: (segmentId: string) => string,
): { read(segmentId: string): Promise<Uint8Array> } {
  return {
    async read(segmentId: string): Promise<Uint8Array> {
      const buffer = await readFile(resolveWithinRoot(rootDirectory, fileNameFor(segmentId)));
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    },
  };
}

/** Reads the dataset manifest's bytes verbatim. */
export async function readManifestBytes(
  rootDirectory: string,
  manifestFileName: string,
): Promise<Uint8Array> {
  const buffer = await readFile(join(resolve(rootDirectory), manifestFileName));
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
