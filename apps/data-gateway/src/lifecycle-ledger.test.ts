/**
 * The market lifecycle ledger (`UNIV-4`, r1): what it persists, what it
 * refuses, that a failed write ROLLS BACK the in-memory record (the feed's
 * intent-before-dispatch rule depends on it), and that its writes are
 * serialized and durable through the WAL filesystem port. The restart and
 * replay properties it exists for are proven end to end in
 * `test/integration/data-gateway/univ-4-market-lifecycle.test.ts`.
 */

import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { describe, expect, it } from "vitest";

import { GatewayStateError } from "./errors.js";
import {
  LIFECYCLE_LEDGER_FILE_NAME,
  LIFECYCLE_LEDGER_SCHEMA_VERSION,
  LifecycleLedger,
  type LifecycleLedgerRecord,
} from "./lifecycle-ledger.js";

const MARKET_ID = "01990000-0000-7000-8000-000000000001";
const IDENTITY = {
  internalMarketId: MARKET_ID,
  conditionId: "0x" + "ab".repeat(31),
  gammaMarketId: "900001",
} as const;

function entry(fields: Record<string, unknown>): string {
  return JSON.stringify({ schemaVersion: 1, markets: { [MARKET_ID]: { ...IDENTITY, ...fields } } });
}

describe("LifecycleLedger", () => {
  it("opens empty when the file does not exist, and writes it under the WAL root on the first put", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    expect(ledger.get(MARKET_ID)).toBeUndefined();
    expect(ledger.metrics()).toEqual({ recordsLoaded: 0, writes: 0 });
    await ledger.put({
      ...IDENTITY,
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
          ...IDENTITY,
          firstReadyObservedAt: "2026-09-01T00:00:10.000Z",
          openedAt: "2026-09-01T00:00:00.000Z",
          openedAtOrigin: "configuration",
        },
      },
    });
    expect(ledger.metrics().writes).toBe(1);
  });

  it("re-reads what it wrote: intents and confirmations survive a second open on the same filesystem", async () => {
    const fileSystem = createMemoryFileSystem();
    const first = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    await first.put({
      ...IDENTITY,
      notReadyAfterOpenTimeAt: "2026-09-01T00:00:00.000Z",
      openedAt: "2026-09-01T00:00:10.000Z",
      openedAtOrigin: "observation",
      firstReadyObservedAt: "2026-09-01T00:00:10.000Z",
      openedConfirmedAt: "2026-09-01T00:00:10.005Z",
      scheduledClosesAt: "2026-12-31T00:00:00.000Z",
    });
    await first.put({
      ...first.get(MARKET_ID)!,
      observedClosesAt: "2026-12-30T00:00:00.000Z",
    });
    const second = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    const record = second.get(MARKET_ID);
    expect(record).toEqual({
      ...IDENTITY,
      notReadyAfterOpenTimeAt: "2026-09-01T00:00:00.000Z",
      openedAt: "2026-09-01T00:00:10.000Z",
      openedAtOrigin: "observation",
      firstReadyObservedAt: "2026-09-01T00:00:10.000Z",
      openedConfirmedAt: "2026-09-01T00:00:10.005Z",
      scheduledClosesAt: "2026-12-31T00:00:00.000Z",
      observedClosesAt: "2026-12-30T00:00:00.000Z",
    });
    // The unconfirmed intents are readable as such.
    expect(record?.scheduledClosingConfirmedAt).toBeUndefined();
    expect(record?.observedClosingConfirmedAt).toBeUndefined();
    expect(second.metrics()).toEqual({ recordsLoaded: 1, writes: 0 });
  });

  it("serializes concurrent puts: the file holds the last state and every write completed", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    const other = "01990000-0000-7000-8000-000000000002";
    await Promise.all([
      ledger.put({ ...IDENTITY, contradictedAt: "2026-09-01T00:00:00.000Z" }),
      ledger.put({
        internalMarketId: other,
        conditionId: "0x" + "cd".repeat(31),
        gammaMarketId: "900002",
        contradictedAt: "2026-09-01T00:00:01.000Z",
      }),
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
    ["an entry that is not an object", JSON.stringify({ schemaVersion: 1, markets: { [MARKET_ID]: "opened" } })],
    ["an entry with an unknown key", entry({ openedAt: "x", openedAtOrigin: "observation", extra: 1 })],
    [
      "an entry whose id does not match its key",
      JSON.stringify({ schemaVersion: 1, markets: { [MARKET_ID]: { ...IDENTITY, internalMarketId: "other" } } }),
    ],
    [
      "an entry without its identity pair",
      JSON.stringify({ schemaVersion: 1, markets: { [MARKET_ID]: { internalMarketId: MARKET_ID } } }),
    ],
    ["openedAt without its origin", entry({ openedAt: "2026-09-01T00:00:00.000Z" })],
    ["an unknown origin", entry({ openedAt: "2026-09-01T00:00:00.000Z", openedAtOrigin: "guess" })],
    ["a non-string instant", entry({ contradictedAt: 1_760_000_000_000 })],
    ["a malformed openedAt (r2)", entry({ openedAt: "yesterday", openedAtOrigin: "observation" })],
    ["a malformed confirmation instant (r2)", entry({ openedAt: "2026-09-01T00:00:00.000Z", openedAtOrigin: "observation", openedConfirmedAt: "2026-09-01" })],
    ["a malformed closesAt (r2)", entry({ scheduledClosesAt: "12:15" })],
    ["a confirmation without its intent (opened)", entry({ openedConfirmedAt: "2026-09-01T00:00:00.000Z" })],
    [
      "a confirmation without its intent (scheduled closing)",
      entry({ scheduledClosingConfirmedAt: "2026-09-01T00:00:00.000Z" }),
    ],
    [
      "a confirmation without its intent (observed closing)",
      entry({ observedClosingConfirmedAt: "2026-09-01T00:00:00.000Z" }),
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

  it("names the malformed field in the typed refusal (r2, MEDIUM-R1)", () => {
    let thrown: unknown;
    try {
      LifecycleLedger.decode(entry({ openedAt: "not-an-instant", openedAtOrigin: "observation" }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayStateError);
    expect((thrown as GatewayStateError).message).toContain("openedAt");
    expect((thrown as GatewayStateError).message).toContain("ISO-8601");
    expect((thrown as GatewayStateError).details).toMatchObject({ key: "openedAt", value: "not-an-instant" });
    // Every instant grammar the frozen contract accepts is accepted here too.
    expect(
      LifecycleLedger.decode(
        entry({ openedAt: "2026-09-01T00:00:00+02:00", openedAtOrigin: "observation", contradictedAt: "2026-09-01T00:00:00Z" }),
      ),
    ).toHaveLength(1);
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
      const records = LifecycleLedger.decode(entry({ contradictedAt: "2026-09-01T00:00:00.000Z" }));
      expect(records[0]?.openedAt).toBeUndefined();
      expect(Object.hasOwn(records[0] ?? {}, "openedAt")).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, "openedAt");
      if (previous !== undefined) Object.defineProperty(Object.prototype, "openedAt", previous);
    }
  });

  it("a failed write rejects the put, ROLLS BACK the in-memory record, and does not wedge later writes (r1)", async () => {
    const fileSystem = createMemoryFileSystem();
    const ledger = await LifecycleLedger.open({ fileSystem, walRootPath: "/wal" });
    await ledger.put({ ...IDENTITY, firstReadyObservedAt: "2026-09-01T00:00:00.000Z" });
    const durable = ledger.get(MARKET_ID);
    const original = fileSystem.writeWholeFile.bind(fileSystem);
    let failNext = true;
    (fileSystem as { writeWholeFile: typeof fileSystem.writeWholeFile }).writeWholeFile = async (path, bytes) => {
      if (failNext) {
        failNext = false;
        throw new Error("EIO");
      }
      await original(path, bytes);
    };
    const intent: LifecycleLedgerRecord = {
      ...IDENTITY,
      firstReadyObservedAt: "2026-09-01T00:00:00.000Z",
      openedAt: "2026-09-01T00:00:00.000Z",
      openedAtOrigin: "observation",
    };
    await expect(ledger.put(intent)).rejects.toThrow("EIO");
    // The intent that never landed is not what the ledger now answers.
    expect(ledger.get(MARKET_ID)).toEqual(durable);
    expect(ledger.get(MARKET_ID)?.openedAt).toBeUndefined();
    // A first-ever record that fails to land is absent afterwards, not present.
    const other = "01990000-0000-7000-8000-000000000002";
    failNext = true;
    await expect(
      ledger.put({
        internalMarketId: other,
        conditionId: "0xcd",
        gammaMarketId: "2",
        contradictedAt: "2026-09-01T00:00:01.000Z",
      }),
    ).rejects.toThrow("EIO");
    expect(ledger.get(other)).toBeUndefined();
    // The chain is not wedged: the next write lands.
    await ledger.put(intent);
    expect(ledger.metrics().writes).toBe(2);
    expect(JSON.parse(fileSystem.snapshot()[`/wal/${LIFECYCLE_LEDGER_FILE_NAME}`] ?? "")).toMatchObject({
      markets: { [MARKET_ID]: { openedAt: "2026-09-01T00:00:00.000Z" } },
    });
  });
});
