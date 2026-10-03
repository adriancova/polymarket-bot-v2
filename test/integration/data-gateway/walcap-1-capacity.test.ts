/**
 * `WALCAP-1` — the WAL's `maxTotalBytes` on a whole gateway (ADR-028 D5;
 * closes `STORAGE1-MAXBYTES`).
 *
 * - **D5.3, visible:** reaching the cap refuses new frames and pages
 *   `GATEWAY_WAL_CAPACITY_REACHED`, once per episode, beside the per-feed
 *   `GATEWAY_WAL_FRAME_REFUSED`; the writer's `capacityReached` and
 *   `capacityRefusals` metrics move. Nothing on disk is deleted or rewritten.
 * - **J10, relief:** once raw-WAL expiry deletes a sealed segment, the next
 *   gateway tick gives its bytes back and the gateway records again, its
 *   market data published again. The next time the cap is reached pages again.
 * - **One cap for the WAL root:** a restarted gateway (a new epoch, so a new
 *   directory) counts the earlier epoch's segments.
 * - **D5.1:** a configuration that declares the ADR-025 laptop profile does
 *   not start without `maxTotalBytes`.
 *
 * After every step: the segment bytes on disk under the WAL root never exceed
 * `maxTotalBytes`, and the writer's count is never below them.
 */

import type { MemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { GatewayConfigurationError, WAL_CAPACITY_REACHED_REASON_CODE } from "@polymarket-bot/data-gateway";
import { describe, expect, it } from "vitest";

import { binanceTradeFrame, buildHarness } from "./support/harness.js";
import type { Harness } from "./support/harness.js";

const CAP = 9_000;
const BINANCE = { feedId: "binance-reference", symbols: ["BTCUSDT"], stalenessThresholdMs: 30_000 };
const CONFIG = { wal: { rootPath: "/wal", maxTotalBytes: CAP, maxSegmentBytes: 2_000 }, binance: BINANCE };

function segmentBytesUnderRoot(fileSystem: MemoryFileSystem): number {
  let total = 0;
  for (const [path, bytes] of fileSystem.files) {
    if (path.startsWith("/wal/") && path.endsWith(".wal.jsonl")) total += bytes.length;
  }
  return total;
}

function expectBounded(harness: Harness): void {
  const disk = segmentBytesUnderRoot(harness.walFileSystem);
  expect(disk).toBeLessThanOrEqual(CAP);
  expect(harness.gateway.metrics().wal.totalSegmentBytes).toBeGreaterThanOrEqual(disk);
}

function capacityPages(harness: Harness): number {
  return harness.incidents.filter((incident) => incident.reasonCode === WAL_CAPACITY_REACHED_REASON_CODE).length;
}

/** Sends trade frames one at a time until the WAL refuses one for capacity. */
async function tradeUntilRefused(harness: Harness, firstTradeId: number): Promise<number> {
  const socket = harness.binanceSockets.current;
  for (let index = 0; index < 200; index += 1) {
    const refusedBefore = harness.gateway.metrics().binance?.framesRefusedByWal ?? 0;
    harness.clock.advance(5);
    socket.message(binanceTradeFrame("BTCUSDT", firstTradeId + index, harness.clock.nowMs()));
    await harness.settle();
    expectBounded(harness);
    if ((harness.gateway.metrics().binance?.framesRefusedByWal ?? 0) > refusedBefore) {
      return firstTradeId + index;
    }
  }
  throw new Error("the cap never refused a frame");
}

/** Raw-WAL expiry, as the research worker does it: the oldest sealed segment, then its sidecar. */
function expireOldestSealed(fileSystem: MemoryFileSystem): number {
  const manifest = [...fileSystem.files.keys()].filter((path) => path.endsWith(".wal.manifest.json")).sort()[0];
  if (manifest === undefined) throw new Error("no sealed segment to expire");
  const segment = manifest.replace(/\.wal\.manifest\.json$/u, ".wal.jsonl");
  const bytes = fileSystem.peek(segment)?.length ?? 0;
  fileSystem.files.delete(segment);
  fileSystem.files.delete(manifest);
  return bytes;
}

function publishedTradeIds(harness: Harness): readonly number[] {
  return harness
    .publishedOfType("ReferenceTradeObserved")
    .map((envelope) => Number((envelope.payload as { venueTradeId?: string }).venueTradeId));
}

describe("maxTotalBytes on a running gateway (WALCAP-1)", () => {
  it("pages once at the cap, deletes nothing, and records again after expiry frees a segment", async () => {
    const harness = await buildHarness({ config: CONFIG });
    harness.gateway.start();
    harness.binanceSockets.current.open();

    const refusedTrade = await tradeUntilRefused(harness, 1);
    expect(refusedTrade).toBeGreaterThan(5);
    const wal = harness.gateway.metrics().wal;
    expect(wal.capacityReached).toBe(true);
    expect(wal.capacityRefusals).toBe(1);
    expect(capacityPages(harness)).toBe(1);
    const page = harness.incidents.find((incident) => incident.reasonCode === WAL_CAPACITY_REACHED_REASON_CODE);
    expect(page?.severity).toBe("PAGE");
    expect(page?.detail).toContain(`WAL capacity threshold of ${String(CAP)} bytes reached`);
    expect(harness.recordingFailures).toContain("capacity-exceeded");
    // The refused frame's market data is not published.
    expect(publishedTradeIds(harness)).not.toContain(refusedTrade);

    // Still at the cap: more refusals, the same one page, nothing on disk
    // touched to make room — a tick re-derives the count and finds nothing.
    const onDisk = harness.walFileSystem.snapshot();
    const socket = harness.binanceSockets.current;
    socket.message(binanceTradeFrame("BTCUSDT", refusedTrade + 1, harness.clock.nowMs()));
    await harness.gateway.tick();
    socket.message(binanceTradeFrame("BTCUSDT", refusedTrade + 2, harness.clock.nowMs()));
    await harness.settle();
    expect(harness.gateway.metrics().wal.capacityRefusals).toBe(3);
    expect(capacityPages(harness)).toBe(1);
    expect(harness.walFileSystem.snapshot()).toStrictEqual(onDisk);
    expect(harness.walFileSystem.stats.truncations).toBe(0);

    // Expiry deletes the oldest sealed segment; the next tick gives it back.
    const freed = expireOldestSealed(harness.walFileSystem);
    expect(freed).toBeGreaterThan(0);
    await harness.gateway.tick();
    expect(harness.gateway.metrics().wal.capacityRelievedBytes).toBe(freed);

    const recordedBefore = harness.gateway.metrics().binance?.framesRecorded ?? 0;
    harness.clock.advance(5);
    socket.message(binanceTradeFrame("BTCUSDT", 500, harness.clock.nowMs()));
    await harness.settle();
    expect(harness.gateway.metrics().binance?.framesRecorded).toBe(recordedBefore + 1);
    expect(harness.gateway.metrics().wal.capacityReached).toBe(false);
    expect(publishedTradeIds(harness)).toContain(500);
    expectBounded(harness);

    // The next episode is a new page.
    await tradeUntilRefused(harness, 600);
    expect(capacityPages(harness)).toBe(2);
    expectBounded(harness);
    await harness.gateway.stop();
    expectBounded(harness);
  });

  it("a restarted gateway counts the earlier epoch's segments: one cap for the WAL root", async () => {
    const first = await buildHarness({ config: CONFIG, idSeed: 1 });
    first.gateway.start();
    first.binanceSockets.current.open();
    await tradeUntilRefused(first, 1);
    await first.gateway.stop();
    const afterFirst = segmentBytesUnderRoot(first.walFileSystem);

    const second = await buildHarness({ config: CONFIG, idSeed: 2, walFileSystem: first.walFileSystem });
    expect(second.gateway.gatewayEpoch).not.toBe(first.gateway.gatewayEpoch);
    expect(second.gateway.metrics().wal.totalSegmentBytes).toBe(afterFirst);
    second.gateway.start();
    second.binanceSockets.current.open();
    second.binanceSockets.current.message(binanceTradeFrame("BTCUSDT", 1_000, second.clock.nowMs()));
    await second.settle();
    expect(second.gateway.metrics().binance?.framesRefusedByWal).toBe(1);
    expect(capacityPages(second)).toBe(1);
    expectBounded(second);

    expireOldestSealed(second.walFileSystem);
    await second.gateway.tick();
    await tradeUntilRefused(second, 2_000);
    expectBounded(second);
    await second.gateway.stop();
  });

  it("does not start when its first read of the WAL root fails: a count it could not read bounds nothing (round 1, O-M1)", async () => {
    const first = await buildHarness({ config: CONFIG, idSeed: 1 });
    first.gateway.start();
    first.binanceSockets.current.open();
    await tradeUntilRefused(first, 1);
    await first.gateway.stop();
    const disk = first.walFileSystem;
    const before = disk.snapshot();

    let failNext = true;
    const failing: MemoryFileSystem = {
      ...disk,
      listDirectoryNames: async (directory) => {
        if (failNext && directory === "/wal") {
          failNext = false;
          throw new Error("EIO (injected root listing)");
        }
        return (await disk.listDirectoryNames?.(directory)) ?? [];
      },
    };
    await expect(buildHarness({ config: CONFIG, idSeed: 2, walFileSystem: failing })).rejects.toThrow(
      "EIO (injected root listing)",
    );
    expect(failNext).toBe(false);
    expect(disk.snapshot()).toStrictEqual(before);

    // Once the root answers, the restart counts the earlier epoch and stays at the cap.
    const second = await buildHarness({ config: CONFIG, idSeed: 3, walFileSystem: failing });
    expect(second.gateway.metrics().wal.totalSegmentBytes).toBe(segmentBytesUnderRoot(disk));
    expectBounded(second);
    await second.gateway.stop();
  });

  it("does not start a laptop-profile gateway whose configuration leaves maxTotalBytes unset (ADR-028 D5.1)", async () => {
    await expect(
      buildHarness({ config: { hostProfile: "laptop-paper", wal: { rootPath: "/wal" }, binance: BINANCE } }),
    ).rejects.toThrow(GatewayConfigurationError);
    await expect(
      buildHarness({
        config: { hostProfile: "laptop-paper", wal: { rootPath: "/wal", maxTotalBytes: null }, binance: BINANCE },
      }),
    ).rejects.toThrow(GatewayConfigurationError);
    const started = await buildHarness({
      config: { hostProfile: "laptop-paper", wal: { rootPath: "/wal", maxTotalBytes: CAP }, binance: BINANCE },
    });
    expect(started.gateway.metrics().wal.capacityBytes).toBe(CAP);
    await started.gateway.stop();
  });
});
