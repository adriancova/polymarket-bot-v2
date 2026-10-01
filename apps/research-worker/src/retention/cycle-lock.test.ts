/**
 * The state directory's cycle lock (`STORAGE-1` round 5, N2; `STORAGE-1b`):
 * one storage cycle at a time, whatever its mode; a lock held refuses after
 * the timeout, having done nothing; a lock a reboot ended holds nothing.
 *
 * `STORAGE-1b` pins the two round-6 findings:
 * - R6-LOCK-OPEN-ERROR-UNTESTED: a lock that cannot be created for any reason
 *   but "already held" refuses at once, running nothing and removing nothing
 *   (mutant Q3, `throw` → `break`, ran the work unlocked and then removed
 *   another cycle's lock);
 * - R6-LOCK-NAME-FALLBACK: a cycle that cannot read the boot id refuses
 *   before it creates anything, so two cycles on one host never hold
 *   different lock names (the round-6 pairings: `null` vs a boot id, a boot id
 *   vs `null`, and the same-boot control).
 *
 * Real files in a temporary directory; a failure of the filesystem or of the
 * boot id's read is injected.
 */

import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { StorageCycleLockFileSystem } from "./cycle-lock.js";
import {
  KERNEL_BOOT_ID_PATH,
  LEGACY_STORAGE_CYCLE_LOCK_FILE_NAME,
  StorageCycleLockError,
  hostBootId,
  isBootId,
  nodeStorageCycleLockFileSystem,
  storageCycleLockPath,
  withStorageCycleLock,
} from "./cycle-lock.js";

let directories: string[] = [];
afterEach(async () => {
  for (const directory of directories) {
    await chmod(join(directory, "state"), 0o700).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
  directories = [];
});
async function temporaryRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "storage1-cycle-lock-"));
  directories.push(directory);
  return directory;
}
async function stateDirectory(): Promise<string> {
  return join(await temporaryRoot(), "state");
}

const BOOT = "0b7a2c64-8f1e-4c1a-9d3e-2f6a5b4c3d21";
const OTHER_BOOT = "ffffffff-0000-4000-8000-000000000000";
const HOLDER = '{"pid":4242,"acquiredAt":"2026-01-01T00:00:00.000Z"}\n';
const boot = (id: string) => async () => id;

function errno(code: string, path: string): NodeJS.ErrnoException {
  const error = new Error(`${code}: injected failure, open '${path}'`) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

/** The real lock file operations, each call recorded; `overrides` replace some. */
function recordingFileSystem(overrides: Partial<StorageCycleLockFileSystem> = {}): {
  readonly fileSystem: StorageCycleLockFileSystem;
  readonly calls: { readonly open: string[]; readonly lstat: string[]; readonly unlink: string[] };
} {
  const calls = { open: [] as string[], lstat: [] as string[], unlink: [] as string[] };
  const real = nodeStorageCycleLockFileSystem;
  return {
    calls,
    fileSystem: {
      async open(path, flags, mode) {
        calls.open.push(path);
        return await (overrides.open ?? real.open)(path, flags, mode);
      },
      async lstat(path) {
        calls.lstat.push(path);
        return await (overrides.lstat ?? real.lstat)(path);
      },
      async unlink(path) {
        calls.unlink.push(path);
        await (overrides.unlink ?? real.unlink)(path);
      },
    },
  };
}

/** Every file in a directory, by name, with its bytes. */
async function snapshot(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of (await readdir(directory)).sort()) files[name] = await readFile(join(directory, name), "utf8");
  return files;
}

/** What a promise rejected with, or `null` where it resolved. Asserts nothing. */
async function settled(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => null,
    (error: unknown) => error,
  );
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const outcome = await settled(promise);
  expect(outcome).toBeInstanceOf(Error);
  return outcome as Error;
}

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

  it("refuses while this boot's lock is held, naming the holder, and never runs the work", async () => {
    const state = await stateDirectory();
    await withStorageCycleLock(state, { bootId: boot(BOOT) }, async () => undefined);
    const path = storageCycleLockPath(state, BOOT);
    await writeFile(path, HOLDER);
    let ran = false;
    const attempt = withStorageCycleLock(state, { bootId: boot(BOOT), timeoutMs: 60, pollMs: 10 }, async () => {
      ran = true;
    });
    await expect(attempt).rejects.toBeInstanceOf(StorageCycleLockError);
    // A string: the message contains it.
    await expect(attempt).rejects.toThrow(`another storage cycle holds ${path} ({"pid":4242`);
    expect(ran).toBe(false);
    // The holder's file is left as it was.
    expect(await readFile(path, "utf8")).toBe(HOLDER);
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
    await withStorageCycleLock(state, { bootId: boot(OTHER_BOOT) }, async () => undefined);
    const stale = storageCycleLockPath(state, OTHER_BOOT);
    await writeFile(stale, `{"pid":4242,"bootId":"${OTHER_BOOT}"}\n`);
    expect(await withStorageCycleLock(state, { bootId: boot(BOOT), timeoutMs: 0 }, async () => "ran")).toBe("ran");
    // It is inert, and left for the operator.
    expect(await readdir(state)).toStrictEqual([stale.slice(state.length + 1)]);
  });
});

describe("R6-LOCK-OPEN-ERROR-UNTESTED: a lock that cannot be created refuses at once, runs nothing and removes nothing", () => {
  // The hazard (mutant Q3): an open() that fails with anything but EEXIST was
  // treated as taken; the work ran unlocked and its `finally` removed the file
  // at the lock's path, which may be another cycle's. EMFILE and ENFILE come
  // before EEXIST in the kernel, so they can fail an open while another cycle
  // holds the lock: here it does.
  it.each(["EACCES", "EROFS", "ENOSPC", "EMFILE", "ENFILE", "EPERM", "EIO", "EDQUOT", "ENOTDIR"])(
    "open() failing with %s while another cycle holds the lock: the error names it; the work never runs; nothing is unlinked",
    async (code) => {
      const state = await stateDirectory();
      await mkdir(state, { recursive: true });
      const path = storageCycleLockPath(state, BOOT);
      await writeFile(path, HOLDER);
      await writeFile(join(state, "evidence-holds.json"), "{}");
      const before = await snapshot(state);
      const injected = errno(code, path);
      const { fileSystem, calls } = recordingFileSystem({
        open: async () => {
          throw injected;
        },
      });
      let ran = false;
      // A long timeout: an error but EEXIST is not a holder to wait for.
      const outcome = await settled(
        withStorageCycleLock(state, { bootId: boot(BOOT), fileSystem, timeoutMs: 60_000, pollMs: 10 }, async () => {
          ran = true;
        }),
      );
      // The hazard first: the work never ran unlocked, and nothing removed the
      // holder's lock; it and every other file are left exactly as they were.
      expect(ran).toBe(false);
      expect(calls.unlink).toStrictEqual([]);
      expect(await snapshot(state)).toStrictEqual(before);
      // One attempt: not waited on as if held.
      expect(calls.open).toStrictEqual([path]);
      // The refusal names the cause.
      expect(outcome).toBeInstanceOf(StorageCycleLockError);
      const error = outcome as StorageCycleLockError;
      expect(error.cause).toBe(injected);
      expect(error.message).toContain(`the storage cycle lock ${path} cannot be created (${code}: injected failure`);
      expect(error.message).toContain("nothing was done, and nothing was removed");
    },
  );

  it("with no other holder, it creates nothing either", async () => {
    const state = await stateDirectory();
    const injected = errno("EROFS", "x");
    const { fileSystem, calls } = recordingFileSystem({
      open: async () => {
        throw injected;
      },
    });
    let ran = false;
    const outcome = await settled(
      withStorageCycleLock(state, { bootId: boot(BOOT), fileSystem }, async () => {
        ran = true;
      }),
    );
    expect(ran).toBe(false);
    expect(calls.unlink).toStrictEqual([]);
    expect(await readdir(state)).toStrictEqual([]);
    expect(outcome).toBeInstanceOf(StorageCycleLockError);
    expect((outcome as Error).cause).toBe(injected);
  });

  // Root ignores directory permissions; the injected cases above cover it there.
  it.skipIf(process.getuid?.() === 0)("a real EACCES (a state directory this process may not write): refuses, runs nothing, unlinks nothing", async () => {
    const state = await stateDirectory();
    await mkdir(state, { recursive: true });
    await chmod(state, 0o500);
    const { fileSystem, calls } = recordingFileSystem();
    let ran = false;
    const outcome = await settled(
      withStorageCycleLock(state, { bootId: boot(BOOT), fileSystem, timeoutMs: 60_000 }, async () => {
        ran = true;
      }),
    );
    expect(ran).toBe(false);
    expect(calls.unlink).toStrictEqual([]);
    expect(await readdir(state)).toStrictEqual([]);
    expect(outcome).toBeInstanceOf(StorageCycleLockError);
    expect(((outcome as Error).cause as NodeJS.ErrnoException).code).toBe("EACCES");
  });

  it("a held lock (EEXIST) is still waited for, not refused at once: the control", async () => {
    const state = await stateDirectory();
    await mkdir(state, { recursive: true });
    const path = storageCycleLockPath(state, BOOT);
    await writeFile(path, HOLDER);
    const { fileSystem, calls } = recordingFileSystem();
    const attempt = withStorageCycleLock(state, { bootId: boot(BOOT), fileSystem, timeoutMs: 10_000, pollMs: 10 }, async () => "ran");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(calls.open.length).toBeGreaterThan(1);
    await rm(path);
    expect(await attempt).toBe("ran");
    expect(calls.unlink).toStrictEqual([path]);
  });
});

describe("R6-LOCK-NAME-FALLBACK: a cycle that cannot read the boot id refuses before it creates anything", () => {
  // `subset=pid` (systemd ProcSubset=pid) gives ENOENT; an LSM denial EACCES.
  it.each(["ENOENT", "EACCES", "EPERM", "EIO", "EMFILE"])("a boot id read failing with %s: refuses, naming the cause", async (code) => {
    const root = await temporaryRoot();
    const state = join(root, "state");
    const injected = errno(code, KERNEL_BOOT_ID_PATH);
    let ran = false;
    const error = await rejection(
      withStorageCycleLock(
        state,
        {
          bootId: async () => {
            throw injected;
          },
        },
        async () => {
          ran = true;
        },
      ),
    );
    expect(error).toBeInstanceOf(StorageCycleLockError);
    expect(error.cause).toBe(injected);
    expect(error.message).toContain(`this host's boot id cannot be read (${code}: injected failure, open '${KERNEL_BOOT_ID_PATH}'); nothing was done`);
    expect(error.message).toContain("ProcSubset=pid");
    expect(ran).toBe(false);
    // Not even the state directory was created.
    expect(await readdir(root)).toStrictEqual([]);
  });

  it.each([
    ["empty", ""],
    ["not a UUID", "boot-before"],
    ["a path", "../../etc/passwd"],
    ["in upper case", BOOT.toUpperCase()],
    ["with more after it", `${BOOT} ${BOOT}`],
    ["the old fallback's name", "storage-cycle"],
  ])("a boot id that reads %s is not a boot id: refuses, naming it", async (_name, value) => {
    const root = await temporaryRoot();
    const state = join(root, "state");
    let ran = false;
    const error = await rejection(
      withStorageCycleLock(state, { bootId: boot(value) }, async () => {
        ran = true;
      }),
    );
    expect(error).toBeInstanceOf(StorageCycleLockError);
    expect(error.message).toContain(`this host's boot id reads as ${JSON.stringify(value.slice(0, 64))}, which is not a kernel boot id; nothing was done`);
    expect(error.message).toContain("ProcSubset=pid");
    expect(ran).toBe(false);
    expect(await readdir(root)).toStrictEqual([]);
  });

  /**
   * The round-6 reproduction's pairings, each on one state directory: A takes
   * the lock and holds it; B starts while A holds it. What ran, in order, and
   * how each ended.
   */
  async function pairing(
    a: () => Promise<string>,
    b: () => Promise<string>,
  ): Promise<{
    readonly during: readonly string[];
    readonly order: readonly string[];
    readonly a: PromiseSettledResult<unknown>;
    readonly b: PromiseSettledResult<unknown>;
    readonly bSettledWhileAHeld: boolean;
    readonly state: string;
  }> {
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
    const first = withStorageCycleLock(state, { bootId: a }, async () => {
      events.push("a:start");
      started();
      await gate;
      events.push("a:end");
    });
    // A either holds the lock, or refused.
    await Promise.race([holding, first.catch(() => undefined)]);
    let bSettled = false;
    const second = withStorageCycleLock(state, { bootId: b, timeoutMs: 10_000, pollMs: 10 }, async () => {
      events.push("b:start");
      events.push("b:end");
    }).finally(() => {
      bSettled = true;
    });
    // Its outcome is read below; a refusal is not an unhandled rejection meanwhile.
    second.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const during = [...events];
    const bSettledWhileAHeld = bSettled;
    release();
    const [aResult, bResult] = await Promise.allSettled([first, second]);
    return { during, order: events, a: aResult, b: bResult, bSettledWhileAHeld, state };
  }
  // "Cannot read the boot id", both ways a reader can say it: the round-6
  // seam's `null` (its `hostBootId` turned every read failure into one, and
  // the lock then fell back to `storage-cycle.lock`), and the read's own
  // rejection (ENOENT under a /proc mounted subset=pid).
  const CANNOT = [
    ["no boot id (null, as the round-6 reader gave)", async (): Promise<string> => null as unknown as string],
    [
      "a read rejected with ENOENT",
      async (): Promise<string> => {
        throw errno("ENOENT", KERNEL_BOOT_ID_PATH);
      },
    ],
  ] as const;
  const lockError = (result: PromiseSettledResult<unknown>): unknown => (result.status === "rejected" ? result.reason : null);

  it("control, both read the same boot id: B waits for A", async () => {
    const run = await pairing(boot(BOOT), boot(BOOT));
    expect(run.during).toStrictEqual(["a:start"]);
    expect(run.order).toStrictEqual(["a:start", "a:end", "b:start", "b:end"]);
    expect([run.a.status, run.b.status]).toStrictEqual(["fulfilled", "fulfilled"]);
  });

  it.each(CANNOT)("A reads the boot id, B gets %s: B refuses at once, while A runs, and A's lock is left alone", async (_name, cannot) => {
    const run = await pairing(boot(BOOT), cannot);
    expect(run.during).toStrictEqual(["a:start"]);
    expect(run.bSettledWhileAHeld).toBe(true);
    expect(lockError(run.b)).toBeInstanceOf(StorageCycleLockError);
    expect(run.order).toStrictEqual(["a:start", "a:end"]);
    expect(run.a.status).toBe("fulfilled");
    expect(await readdir(run.state)).toStrictEqual([]);
  });

  it.each(CANNOT)("A gets %s, B reads the boot id: A refuses before it holds anything; B runs alone", async (_name, cannot) => {
    const run = await pairing(cannot, boot(BOOT));
    expect(lockError(run.a)).toBeInstanceOf(StorageCycleLockError);
    expect(run.order).toStrictEqual(["b:start", "b:end"]);
    expect(run.b.status).toBe("fulfilled");
  });

  it.each(CANNOT)("neither reads it (%s): both refuse, and nothing runs", async (_name, cannot) => {
    const run = await pairing(cannot, cannot);
    expect(lockError(run.a)).toBeInstanceOf(StorageCycleLockError);
    expect(lockError(run.b)).toBeInstanceOf(StorageCycleLockError);
    expect(run.order).toStrictEqual([]);
  });
});

describe("the lock an earlier version fell back to (storage-cycle.lock) counts as held", () => {
  it("a cycle waits for it, then refuses naming it; it never runs the work, takes its own lock, or removes it", async () => {
    const state = await stateDirectory();
    await mkdir(state, { recursive: true });
    const legacy = join(state, LEGACY_STORAGE_CYCLE_LOCK_FILE_NAME);
    expect(legacy).toBe(join(state, "storage-cycle.lock"));
    await writeFile(legacy, HOLDER);
    const before = await snapshot(state);
    const { fileSystem, calls } = recordingFileSystem();
    let ran = false;
    const error = await rejection(
      withStorageCycleLock(state, { bootId: boot(BOOT), fileSystem, timeoutMs: 60, pollMs: 10 }, async () => {
        ran = true;
      }),
    );
    expect(error).toBeInstanceOf(StorageCycleLockError);
    expect(error.message).toContain(`an earlier version's storage cycle lock ${legacy} is present ({"pid":4242`);
    expect(error.message).toContain("If no storage cycle runs on this host, remove it");
    expect(ran).toBe(false);
    expect(calls.open).toStrictEqual([]);
    expect(calls.unlink).toStrictEqual([]);
    expect(await snapshot(state)).toStrictEqual(before);
  });

  it("once it is gone (that cycle ended, or the operator removed it), the waiting cycle runs", async () => {
    const state = await stateDirectory();
    await mkdir(state, { recursive: true });
    const legacy = join(state, LEGACY_STORAGE_CYCLE_LOCK_FILE_NAME);
    await writeFile(legacy, HOLDER);
    let ran = false;
    const attempt = withStorageCycleLock(state, { bootId: boot(BOOT), timeoutMs: 10_000, pollMs: 10 }, async () => {
      ran = true;
      return await readdir(state);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ran).toBe(false);
    expect(await readdir(state)).toStrictEqual([LEGACY_STORAGE_CYCLE_LOCK_FILE_NAME]);
    await rm(legacy);
    expect(await attempt).toStrictEqual([`storage-cycle.${BOOT}.lock`]);
    expect(await readdir(state)).toStrictEqual([]);
  });

  it("whether it exists cannot be read (anything but ENOENT): refuses at once, opening and removing nothing", async () => {
    const state = await stateDirectory();
    const injected = errno("EIO", "x");
    const { fileSystem, calls } = recordingFileSystem({
      lstat: async () => {
        throw injected;
      },
    });
    let ran = false;
    const error = await rejection(
      withStorageCycleLock(state, { bootId: boot(BOOT), fileSystem, timeoutMs: 60_000 }, async () => {
        ran = true;
      }),
    );
    expect(error).toBeInstanceOf(StorageCycleLockError);
    expect(error.cause).toBe(injected);
    expect(error.message).toContain(`whether ${join(state, LEGACY_STORAGE_CYCLE_LOCK_FILE_NAME)} exists cannot be read (EIO`);
    expect(ran).toBe(false);
    expect(calls.open).toStrictEqual([]);
    expect(calls.unlink).toStrictEqual([]);
  });
});

describe("storageCycleLockPath", () => {
  it("names the lock by the boot id, and refuses anything but a kernel boot id: there is no fallback name", () => {
    expect(storageCycleLockPath("/s", BOOT)).toBe(`/s/storage-cycle.${BOOT}.lock`);
    for (const value of [null, undefined, "", "boot-before", "../../etc/passwd", BOOT.toUpperCase(), `${BOOT}/x`]) {
      expect(() => storageCycleLockPath("/s", value as unknown as string)).toThrow(StorageCycleLockError);
      expect(() => storageCycleLockPath("/s", value as unknown as string)).toThrow("is not a kernel boot id, so it names no storage cycle lock");
    }
  });

  it("isBootId accepts the kernel's form only: a lowercase UUID", () => {
    expect(isBootId(BOOT)).toBe(true);
    expect(isBootId(OTHER_BOOT)).toBe(true);
    for (const value of [null, 7, "", " ", BOOT.toUpperCase(), `${BOOT}\n`, BOOT.slice(1), BOOT.replaceAll("-", "")]) expect(isBootId(value)).toBe(false);
  });
});

describe("hostBootId", () => {
  it("reads the kernel's boot id where there is one, the same on every read", async () => {
    if (process.platform !== "linux") {
      await expect(hostBootId()).rejects.toThrow();
      return;
    }
    const first = await hostBootId();
    expect(await hostBootId()).toBe(first);
    expect(isBootId(first)).toBe(true);
  });

  it("rejects where the file is missing (as under a /proc mounted subset=pid), and a cycle reading it refuses, naming that", async () => {
    const root = await temporaryRoot();
    const missing = join(root, "boot_id");
    await expect(hostBootId(missing)).rejects.toMatchObject({ code: "ENOENT" });
    const state = join(root, "state");
    let ran = false;
    const error = await rejection(
      withStorageCycleLock(state, { bootId: async () => await hostBootId(missing) }, async () => {
        ran = true;
      }),
    );
    expect(error).toBeInstanceOf(StorageCycleLockError);
    expect(error.message).toContain(`this host's boot id cannot be read (ENOENT: no such file or directory, open '${missing}')`);
    expect(ran).toBe(false);
    expect(await readdir(root)).toStrictEqual([]);
  });

  it("trims what the kernel prints (one line)", async () => {
    const root = await temporaryRoot();
    const file = join(root, "boot_id");
    await writeFile(file, `${BOOT}\n`);
    expect(await hostBootId(file)).toBe(BOOT);
  });
});
