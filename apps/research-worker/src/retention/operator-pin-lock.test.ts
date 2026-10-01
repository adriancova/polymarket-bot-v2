/**
 * The operator-pin lock and publication (`STORAGE-1` round 1, J6): a
 * publication and an expiry's final check and unlink never interleave.
 */

import { link, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OperatorPinLockError,
  canonicalOperatorPinsPath,
  fileOperatorPinLock,
  operatorPinFile,
  operatorPinLockPath,
  publishOperatorPin,
} from "./operator-pin-lock.js";
import { loadOperatorPins } from "./windows.js";

let root: string;
let pinsPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "storage1-pin-lock-"));
  pinsPath = join(root, "operator-pins.json");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("fileOperatorPinLock", () => {
  it("serializes two holders: the second runs only after the first released", async () => {
    const events: string[] = [];
    const first = fileOperatorPinLock(await operatorPinLockPath(pinsPath), { pollMs: 5 });
    const second = fileOperatorPinLock(await operatorPinLockPath(pinsPath), { pollMs: 5 });
    const one = first.withLock(async () => {
      events.push("first-start");
      await sleep(80);
      events.push("first-end");
    });
    await sleep(10);
    const two = second.withLock(async () => {
      events.push("second-start");
    });
    await Promise.all([one, two]);
    expect(events).toStrictEqual(["first-start", "first-end", "second-start"]);
  });

  it("names the holder when it cannot be taken, and is released after a failure", async () => {
    await writeFile(await operatorPinLockPath(pinsPath), '{"pid":12345,"acquiredAt":"2026-01-01T00:00:00.000Z"}\n');
    const lock = fileOperatorPinLock(await operatorPinLockPath(pinsPath), { timeoutMs: 30, pollMs: 5 });
    await expect(lock.withLock(async () => undefined)).rejects.toThrow(OperatorPinLockError);
    await expect(lock.withLock(async () => undefined)).rejects.toThrow(/held \(\{"pid":12345/u);
    await rm(await operatorPinLockPath(pinsPath));
    await expect(lock.withLock(async () => Promise.reject(new Error("work failed")))).rejects.toThrow("work failed");
    await expect(lock.withLock(async () => "taken again")).resolves.toBe("taken again");
  });
});

describe("publishOperatorPin", () => {
  it("adds a pin durably under the lock, refuses a duplicate id, and leaves no lock behind", async () => {
    const lock = fileOperatorPinLock(await operatorPinLockPath(pinsPath), { pollMs: 5 });
    await publishOperatorPin({
      operatorPinsPath: pinsPath,
      lock,
      pin: { pinId: "p1", from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z", reason: "review" },
    });
    await publishOperatorPin({
      operatorPinsPath: pinsPath,
      lock,
      pin: { pinId: "p2", from: "2026-01-02T00:00:00Z", to: "2026-01-02T01:00:00Z", reason: "review" },
    });
    expect((await loadOperatorPins(pinsPath)).map((pin) => pin.pinId)).toStrictEqual(["p1", "p2"]);
    await expect(
      publishOperatorPin({
        operatorPinsPath: pinsPath,
        lock,
        pin: { pinId: "p1", from: "2026-01-03T00:00:00Z", to: "2026-01-03T01:00:00Z", reason: "again" },
      }),
    ).rejects.toThrow(/listed twice/u);
    expect((await loadOperatorPins(pinsPath)).map((pin) => pin.pinId)).toStrictEqual(["p1", "p2"]);
    await expect(readFile(await operatorPinLockPath(pinsPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits while the lock is held, so a deletion in flight completes before the pin exists", async () => {
    const events: string[] = [];
    const holder = fileOperatorPinLock(await operatorPinLockPath(pinsPath), { pollMs: 5 });
    const deletion = holder.withLock(async () => {
      events.push("final-check");
      await sleep(60);
      events.push("unlink");
    });
    await sleep(10);
    const publication = publishOperatorPin({
      operatorPinsPath: pinsPath,
      lock: fileOperatorPinLock(await operatorPinLockPath(pinsPath), { pollMs: 5 }),
      pin: { pinId: "p", from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z", reason: "review" },
    }).then(() => events.push("published"));
    await Promise.all([deletion, publication]);
    expect(events).toStrictEqual(["final-check", "unlink", "published"]);
  });
});

describe("one file, one lock, however it is spelled (round 2, K6)", () => {
  it("gives a symbolic link and its target the same lock, and publishes to the target", async () => {
    await mkdir(join(root, "real"));
    await mkdir(join(root, "alias"));
    const target = join(root, "real", "pins.json");
    const alias = join(root, "alias", "pins.json");
    await writeFile(target, JSON.stringify({ operatorPinVersion: 1, pins: [] }));
    await symlink(target, alias);
    const canonicalTarget = await realpath(target);
    expect(await operatorPinLockPath(alias)).toBe(await operatorPinLockPath(target));
    expect(await operatorPinLockPath(alias)).toBe(`${canonicalTarget}.lock`);
    expect(await canonicalOperatorPinsPath(alias)).toBe(canonicalTarget);
    // A relative spelling of the same file, too.
    expect(await operatorPinLockPath(relative(process.cwd(), alias))).toBe(`${canonicalTarget}.lock`);
    // The command, given the alias, publishes to the file the timer reads; the alias stays a link.
    const viaAlias = await operatorPinFile(alias, { pollMs: 5 });
    expect(viaAlias.path).toBe(canonicalTarget);
    await publishOperatorPin({
      operatorPinsPath: viaAlias.path,
      lock: viaAlias.lock,
      pin: { pinId: "p", from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z", reason: "review" },
    });
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect((await loadOperatorPins(target)).map((pin) => pin.pinId)).toStrictEqual(["p"]);
  });

  it("serializes a holder through the link with one through the target", async () => {
    const target = join(root, "pins.json");
    const alias = join(root, "alias.json");
    await writeFile(target, JSON.stringify({ operatorPinVersion: 1, pins: [] }));
    await symlink(target, alias);
    const events: string[] = [];
    const viaTarget = (await operatorPinFile(target, { pollMs: 5 })).lock;
    const viaAlias = (await operatorPinFile(alias, { pollMs: 5 })).lock;
    const one = viaTarget.withLock(async () => {
      events.push("target-start");
      await sleep(60);
      events.push("target-end");
    });
    await sleep(10);
    const two = viaAlias.withLock(async () => {
      events.push("alias");
    });
    await Promise.all([one, two]);
    expect(events).toStrictEqual(["target-start", "target-end", "alias"]);
  });

  it("refuses a pin file with a second hard link, and a symbolic link to a missing file", async () => {
    const target = join(root, "pins.json");
    await writeFile(target, JSON.stringify({ operatorPinVersion: 1, pins: [] }));
    await link(target, join(root, "other-name.json"));
    await expect(operatorPinLockPath(target)).rejects.toThrow(OperatorPinLockError);
    await expect(operatorPinFile(join(root, "other-name.json"))).rejects.toThrow(/2 hard links/u);
    await symlink(join(root, "missing.json"), join(root, "dangling.json"));
    await expect(operatorPinLockPath(join(root, "dangling.json"))).rejects.toThrow(/symbolic link to a missing file/u);
    // A file that does not exist yet is named by its directory's canonical path.
    expect(await operatorPinLockPath(join(root, "new.json"))).toBe(join(await realpath(root), "new.json.lock"));
  });
});
