/**
 * The state directory's cycle lock (`STORAGE-1` round 5, N2): one storage
 * cycle at a time, whatever its mode; a lock held refuses after the timeout,
 * having done nothing; a lock a reboot ended holds nothing. Real files in a
 * temporary directory.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { StorageCycleLockError, hostBootId, storageCycleLockPath, withStorageCycleLock } from "./cycle-lock.js";

let directories: string[] = [];
afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories = [];
});
async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "storage1-cycle-lock-"));
  directories.push(directory);
  return join(directory, "state");
}

const BOOT = "0b7a2c64-8f1e-4c1a-9d3e-2f6a5b4c3d21";
const boot = (id: string | null) => async () => id;

describe("withStorageCycleLock", () => {
  it("holds a lock file naming the pid and the boot while the work runs, and removes it after", async () => {
    const state = await stateDirectory();
    const path = storageCycleLockPath(state, BOOT);
    const seen = await withStorageCycleLock(state, { bootId: boot(BOOT) }, async () => JSON.parse(await readFile(path, "utf8")) as unknown);
    expect(seen).toMatchObject({ pid: process.pid, bootId: BOOT, acquiredAt: expect.any(String) });
    expect(await readdir(state)).toStrictEqual([]);
  });

  it("removes it when the work fails, so the next cycle runs", async () => {
    const state = await stateDirectory();
    await expect(withStorageCycleLock(state, { bootId: boot(BOOT) }, async () => Promise.reject(new Error("the cycle failed")))).rejects.toThrow(
      "the cycle failed",
    );
    expect(await readdir(state)).toStrictEqual([]);
    expect(await withStorageCycleLock(state, { bootId: boot(BOOT), timeoutMs: 0 }, async () => "ran")).toBe("ran");
  });

  it.each([
    ["this boot's lock", BOOT],
    ["the lock of a host whose boot id cannot be read", null],
  ] as const)("refuses while %s is held, naming the holder, and never runs the work", async (_name, bootId) => {
    const state = await stateDirectory();
    await withStorageCycleLock(state, { bootId: boot(bootId) }, async () => undefined);
    const path = storageCycleLockPath(state, bootId);
    await writeFile(path, '{"pid":4242,"acquiredAt":"2026-01-01T00:00:00.000Z"}\n');
    let ran = false;
    const attempt = withStorageCycleLock(state, { bootId: boot(bootId), timeoutMs: 60, pollMs: 10 }, async () => {
      ran = true;
    });
    await expect(attempt).rejects.toBeInstanceOf(StorageCycleLockError);
    // A string: the message contains it.
    await expect(attempt).rejects.toThrow(`another storage cycle holds ${path} ({"pid":4242`);
    expect(ran).toBe(false);
    // The holder's file is left as it was.
    expect(await readFile(path, "utf8")).toBe('{"pid":4242,"acquiredAt":"2026-01-01T00:00:00.000Z"}\n');
  });

  it("waits for a running holder, then runs: two cycles never overlap", async () => {
    const state = await stateDirectory();
    const events: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      started = resolve;
    });
    const first = withStorageCycleLock(state, { bootId: boot(BOOT) }, async () => {
      events.push("first:start");
      started();
      await gate;
      events.push("first:end");
    });
    await holding;
    const second = withStorageCycleLock(state, { bootId: boot(BOOT), timeoutMs: 10_000, pollMs: 10 }, async () => {
      events.push("second:start");
      events.push("second:end");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(events).toStrictEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(events).toStrictEqual(["first:start", "first:end", "second:start", "second:end"]);
  });

  it("a lock left by a process a reboot ended holds nothing: its name is another boot's", async () => {
    const state = await stateDirectory();
    await withStorageCycleLock(state, { bootId: boot("boot-before") }, async () => undefined);
    const stale = storageCycleLockPath(state, "boot-before");
    await writeFile(stale, '{"pid":4242,"bootId":"boot-before"}\n');
    expect(await withStorageCycleLock(state, { bootId: boot(BOOT), timeoutMs: 0 }, async () => "ran")).toBe("ran");
    // It is inert, and left for the operator.
    expect(await readdir(state)).toStrictEqual([stale.slice(state.length + 1)]);
  });
});

describe("storageCycleLockPath", () => {
  it("names the lock by the boot id, digests a boot id that is not a plain name, and uses one plain name with none", () => {
    expect(storageCycleLockPath("/s", BOOT)).toBe(`/s/storage-cycle.${BOOT}.lock`);
    expect(storageCycleLockPath("/s", null)).toBe("/s/storage-cycle.lock");
    const odd = storageCycleLockPath("/s", "../../etc/passwd");
    expect(odd).toMatch(/^\/s\/storage-cycle\.[0-9a-f]{32}\.lock$/u);
    expect(storageCycleLockPath("/s", "../../etc/passwd")).toBe(odd);
  });
});

describe("hostBootId", () => {
  it("reads the kernel's boot id where there is one, the same on every read", async () => {
    const first = await hostBootId();
    expect(await hostBootId()).toBe(first);
    if (first !== null) expect(first).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
