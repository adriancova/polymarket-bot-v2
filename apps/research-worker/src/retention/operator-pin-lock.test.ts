/**
 * The operator-pin lock and publication (`STORAGE-1` round 1, J6): a
 * publication and an expiry's final check and unlink never interleave.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OperatorPinLockError, fileOperatorPinLock, operatorPinLockPath, publishOperatorPin } from "./operator-pin-lock.js";
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
    const first = fileOperatorPinLock(operatorPinLockPath(pinsPath), { pollMs: 5 });
    const second = fileOperatorPinLock(operatorPinLockPath(pinsPath), { pollMs: 5 });
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
    await writeFile(operatorPinLockPath(pinsPath), '{"pid":12345,"acquiredAt":"2026-01-01T00:00:00.000Z"}\n');
    const lock = fileOperatorPinLock(operatorPinLockPath(pinsPath), { timeoutMs: 30, pollMs: 5 });
    await expect(lock.withLock(async () => undefined)).rejects.toThrow(OperatorPinLockError);
    await expect(lock.withLock(async () => undefined)).rejects.toThrow(/held \(\{"pid":12345/u);
    await rm(operatorPinLockPath(pinsPath));
    await expect(lock.withLock(async () => Promise.reject(new Error("work failed")))).rejects.toThrow("work failed");
    await expect(lock.withLock(async () => "taken again")).resolves.toBe("taken again");
  });
});

describe("publishOperatorPin", () => {
  it("adds a pin durably under the lock, refuses a duplicate id, and leaves no lock behind", async () => {
    const lock = fileOperatorPinLock(operatorPinLockPath(pinsPath), { pollMs: 5 });
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
    await expect(readFile(operatorPinLockPath(pinsPath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("waits while the lock is held, so a deletion in flight completes before the pin exists", async () => {
    const events: string[] = [];
    const holder = fileOperatorPinLock(operatorPinLockPath(pinsPath), { pollMs: 5 });
    const deletion = holder.withLock(async () => {
      events.push("final-check");
      await sleep(60);
      events.push("unlink");
    });
    await sleep(10);
    const publication = publishOperatorPin({
      operatorPinsPath: pinsPath,
      lock: fileOperatorPinLock(operatorPinLockPath(pinsPath), { pollMs: 5 }),
      pin: { pinId: "p", from: "2026-01-01T00:00:00Z", to: "2026-01-01T01:00:00Z", reason: "review" },
    }).then(() => events.push("published"));
    await Promise.all([deletion, publication]);
    expect(events).toStrictEqual(["final-check", "unlink", "published"]);
  });
});
