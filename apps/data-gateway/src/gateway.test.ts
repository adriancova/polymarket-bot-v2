/**
 * `DataGateway.create()` is transactional over what it acquires (R3-H1).
 *
 * `create()` opens the WAL journal FIRST and only then builds the publisher,
 * dispatcher, directory, plan, and feeds — any of which can refuse its
 * configuration. At `45c231c` such a refusal escaped with the journal (an
 * open WAL writer) simply dropped. The rule now: `create()` either returns a
 * gateway that OWNS the journal (and closes it in `stop()`), or it closes the
 * journal itself before the error escapes — exactly one close, exactly one
 * owner, never both.
 *
 * The journal is created inside `create()`, so the only seam that can observe
 * its disposal without new production surface is the module's own
 * `GatewayJournal.open` — spied here to hand back a close-counting fake.
 */

import { FakeCoinbaseSocketFactory } from "@polymarket-bot/coinbase-adapter/testing";
import { createMemoryFileSystem } from "@polymarket-bot/storage-wal/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseGatewayConfig } from "./config.js";
import { GatewayStateError } from "./errors.js";
import type { GatewayPorts } from "./gateway.js";
import { DataGateway } from "./gateway.js";
import { GatewayJournal } from "./journal.js";
import {
  deterministicIdSource,
  ManualGatewayClock,
  ManualGatewayTimers,
  MemoryEventTransport,
} from "./testing/index.js";

const MARKET = {
  internalMarketId: "01990000-0000-7000-8000-000000000001",
  conditionId: "0x" + "ab".repeat(31),
  yesTokenId: "11111",
  noTokenId: "22222",
  parameters: {
    tickSize: "0.01",
    minimumOrderSize: "5",
    negRisk: false,
    tradingDelaySeconds: 0,
    status: "OPEN",
  },
  observedAt: "2026-08-30T12:00:00.000Z",
} as const;

function ports(overrides: Partial<GatewayPorts> = {}): GatewayPorts {
  const clock = new ManualGatewayClock();
  return {
    clock,
    ids: deterministicIdSource(),
    timers: new ManualGatewayTimers(clock),
    walFileSystem: createMemoryFileSystem(),
    transport: new MemoryEventTransport(),
    coinbaseSocketFactory: new FakeCoinbaseSocketFactory(),
    ...overrides,
  };
}

/** A journal whose only observable duty here is exactly-once `close()`. */
function closeCountingJournal(): { journal: GatewayJournal; closes: () => number } {
  let closes = 0;
  const fake = {
    close: async (): Promise<void> => {
      closes += 1;
    },
    settle: async (): Promise<void> => {
      // Nothing queued: this fake never records.
    },
    tick: async (): Promise<void> => {},
  };
  return { journal: fake as unknown as GatewayJournal, closes: () => closes };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DataGateway.create() transactionality (R3-H1)", () => {
  it("closes the journal it opened when feed construction refuses the configuration", async () => {
    const { journal, closes } = closeCountingJournal();
    const openSpy = vi.spyOn(GatewayJournal, "open").mockResolvedValue(journal);

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [MARKET],
      // Configured feed, MISSING port: #buildFeeds throws after the journal
      // opened — the same post-open window every later create() failure uses.
      polymarket: { feedId: "pm-main" },
    });

    await expect(DataGateway.create(config, ports())).rejects.toBeInstanceOf(GatewayStateError);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(closes(), "the opened journal must be closed exactly once").toBe(1);
  });

  it("transfers journal ownership to the gateway on success: create() closes nothing, stop() closes exactly once", async () => {
    const { journal, closes } = closeCountingJournal();
    vi.spyOn(GatewayJournal, "open").mockResolvedValue(journal);

    const config = parseGatewayConfig({
      streamName: "market-events",
      wal: { rootPath: "/wal" },
      markets: [],
      coinbase: { productIds: ["BTC-USD"] },
    });

    const gateway = await DataGateway.create(config, ports());
    expect(closes(), "a successful create() must not close its own journal").toBe(0);

    gateway.start();
    await gateway.stop();
    expect(closes()).toBe(1);

    await gateway.stop();
    expect(closes(), "double stop stays exactly-once").toBe(1);
  });
});
