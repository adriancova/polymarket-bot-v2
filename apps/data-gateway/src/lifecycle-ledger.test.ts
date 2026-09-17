/**
 * The market lifecycle ledger (`UNIV-4`): what it persists, what it refuses,
 * and that its writes are serialized and durable through the WAL filesystem
 * port. The restart property it exists for is proven end to end in
 * `test/integration/data-gateway/univ-4-market-lifecycle.test.ts`.
 */

import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { describe, expect, it } from "vitest";

import { GatewayStateError } from "./errors.js";
import {
  LIFECYCLE_LEDGER_FILE_NAME,
  LIFECYCLE_LEDGER_SCHEMA_VERSION,
  LifecycleLedger,
} from "./lifecycle-ledger.js";

const MARKET_ID = "01990000-0000-7000-8000-000000000001";

describe("LifecycleLedger", () => {
  it("opens empty when the file does not exist, and writes it under the WAL root on the first put", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(ledger.get(MARKET_ID)).toBeUndefined();
    expect(ledger.metrics()).toEqual({ recordsLoaded: 0, writes: 0 });
    await ledger.put({
      internalMarketId: MARKET_ID,
      openedAt: "2026-09-01T00:00:00.000Z",
      openedAtOrigin: "configuration",
      firstReadyObservedAt: "2026-09-01T00:00:10.000Z",
    });
    expect(ledger.path).toBe(`/wal/${LIFECYCLE_LEDGER_FILE_NAME}`);
    const text = fileSystem.snapshot()[`/wal/${LIFECYCLE_LEDGER_FILE_NAME}`];
    expect(text).toBeDefined();
    expect(JSON.parse(text ?? "")).toEqual({
      schemaVersion: LIFECYCLE_LEDGER_SCHEMA_VERSION,
      markets: {
        [MARKET_ID]: {
          internalMarketId: MARKET_ID,
          openedAt: "2026-09-01T00:00:00.000Z",
          openedAtOrigin: "configuration",
          firstReadyObservedAt: "2026-09-01T00:00:10.000Z",
        },
      },
    });
    expect(ledger.metrics().writes).toBe(1);
  });

  it("re-reads what it wrote: a second open on the same filesystem holds the same records", async () => {
    const fileSystem = createMemoryFileSystem();
    const first = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    await first.put({
      internalMarketId: MARKET_ID,
      openedAt: "2026-09-01T00:00:00.000Z",
      openedAtOrigin: "observation",
      firstReadyObservedAt: "2026-09-01T00:00:00.000Z",
      scheduledClosesAt: "2026-12-31T00:00:00.000Z",
    });
    await first.put({
      ...first.get(MARKET_ID)!,
      observedClosesAt: "2026-12-30T00:00:00.000Z",
    });
    const second = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(second.get(MARKET_ID)).toEqual({
      internalMarketId: MARKET_ID,
      openedAt: "2026-09-01T00:00:00.000Z",
      openedAtOrigin: "observation",
      firstReadyObservedAt: "2026-09-01T00:00:00.000Z",
      scheduledClosesAt: "2026-12-31T00:00:00.000Z",
      observedClosesAt: "2026-12-30T00:00:00.000Z",
    });
    expect(second.metrics()).toEqual({ recordsLoaded: 1, writes: 0 });
  });

  it("serializes concurrent puts: the file holds the last state and every write completed", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    const other = "01990000-0000-7000-8000-000000000002";
    await Promise.all([
      ledger.put({ internalMarketId: MARKET_ID, contradictedAt: "2026-09-01T00:00:00.000Z" }),
      ledger.put({ internalMarketId: other, contradictedAt: "2026-09-01T00:00:01.000Z" }),
    ]);
    await ledger.settle();
    const reread = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(reread.records().map((record) => record.internalMarketId).sort()).toEqual([MARKET_ID, other]);
    expect(ledger.metrics().writes).toBe(2);
  });

  it.each([
    ["not JSON", "{ nope"],
    ["an array", "[]"],
    ["an unknown schemaVersion", JSON.stringify({ schemaVersion: 2, markets: {} })],
    ["no markets object", JSON.stringify({ schemaVersion: 1 })],
    [
      "an entry that is not an object",
      JSON.stringify({ schemaVersion: 1, markets: { [MARKET_ID]: "opened" } }),
    ],
    [
      "an entry with an unknown key",
      JSON.stringify({
        schemaVersion: 1,
        markets: { [MARKET_ID]: { internalMarketId: MARKET_ID, openedAt: "x", openedAtOrigin: "observation", extra: 1 } },
      }),
    ],
    [
      "an entry whose id does not match its key",
      JSON.stringify({
        schemaVersion: 1,
        markets: { [MARKET_ID]: { internalMarketId: "other" } },
      }),
    ],
    [
      "openedAt without its origin",
      JSON.stringify({
        schemaVersion: 1,
        markets: { [MARKET_ID]: { internalMarketId: MARKET_ID, openedAt: "2026-09-01T00:00:00.000Z" } },
      }),
    ],
    [
      "an unknown origin",
      JSON.stringify({
        schemaVersion: 1,
        markets: {
          [MARKET_ID]: { internalMarketId: MARKET_ID, openedAt: "2026-09-01T00:00:00.000Z", openedAtOrigin: "guess" },
        },
      }),
    ],
    [
      "a non-string instant",
      JSON.stringify({
        schemaVersion: 1,
        markets: { [MARKET_ID]: { internalMarketId: MARKET_ID, contradictedAt: 1_760_000_000_000 } },
      }),
    ],
  ])("refuses an unreadable ledger (%s) instead of replacing it", async (_label, text) => {
    const fileSystem = createMemoryFileSystem();
    await fileSystem.ensureDirectory("/wal");
    await fileSystem.writeWholeFile(`/wal/${LIFECYCLE_LEDGER_FILE_NAME}`, Buffer.from(text, "utf8"));
    await expect(LifecycleLedger.open({ fileSystem, walRootPath: "/wal" })).rejects.toBeInstanceOf(
      GatewayStateError,
    );
    // Untouched: the refusal did not rewrite the file.
    expect(fileSystem.snapshot()[`/wal/${LIFECYCLE_LEDGER_FILE_NAME}`]).toBe(text);
  });

  it("reads the document as own data: an inherited openedAt is not adopted", () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "openedAt");
    Object.defineProperty(Object.prototype, "openedAt", {
      value: "1970-01-01T00:00:00.000Z",
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      const records = LifecycleLedger.decode(
        JSON.stringify({
          schemaVersion: 1,
          markets: { [MARKET_ID]: { internalMarketId: MARKET_ID, contradictedAt: "2026-09-01T00:00:00.000Z" } },
        }),
      );
      expect(records[0]?.openedAt).toBeUndefined();
      expect(Object.hasOwn(records[0] ?? {}, "openedAt")).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, "openedAt");
      if (previous !== undefined) Object.defineProperty(Object.prototype, "openedAt", previous);
    }
  });

  it("a failed write rejects the put, reports through the caller, and does not wedge later writes", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    const original = fileSystem.writeWholeFile.bind(fileSystem);
    let failNext = true;
    (fileSystem as { writeWholeFile: typeof fileSystem.writeWholeFile }).writeWholeFile = async (path, bytes) => {
      if (failNext) {
        failNext = false;
        throw new Error("EIO");
      }
      await original(path, bytes);
    };
    await expect(
      ledger.put({ internalMarketId: MARKET_ID, contradictedAt: "2026-09-01T00:00:00.000Z" }),
    ).rejects.toThrow("EIO");
    await ledger.put({ internalMarketId: MARKET_ID, contradictedAt: "2026-09-01T00:00:01.000Z" });
    expect(ledger.metrics().writes).toBe(1);
    expect(JSON.parse(fileSystem.snapshot()[`/wal/${LIFECYCLE_LEDGER_FILE_NAME}`] ?? "")).toMatchObject({
      markets: { [MARKET_ID]: { contradictedAt: "2026-09-01T00:00:01.000Z" } },
    });
  });
});
