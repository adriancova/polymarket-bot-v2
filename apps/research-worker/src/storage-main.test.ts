/**
 * The storage command's composition root (`STORAGE-1` round 2, K6): the
 * timer and the `storage pin` command reach the operator-pin lock and file by
 * their canonical path, however the configuration spells them. Real files in
 * a temporary directory; the deletion runs only where the test opted in.
 */

import { lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { EXPIRY_OPT_IN_MARKER_CONTENT, EXPIRY_OPT_IN_MARKER_FILE_NAME } from "@polymarket-bot/storage-parquet";

import { loadOperatorPins } from "./retention/windows.js";
import { storageMain, storagePinMain } from "./storage-main.js";
import { HOUR, storageFixture, tradeFrame } from "./testing/storage-fixture.js";
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
