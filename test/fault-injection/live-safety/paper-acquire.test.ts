/**
 * The packet's fault "a PAPER process tries to acquire"; work-plan acceptance
 * "Paper mode cannot acquire live fencing" (ADR-008 §2; ADR-010; ADR-033
 * D4). Every layer refuses on its own, each before it touches the next:
 *
 * 1. the live-safety composition (`createLiveSafety`);
 * 2. the fencing authority (`FencingAuthority.create`);
 * 3. the PostgreSQL lease store (`createFencingLeaseStore(...).acquire`),
 *    before any SQL: its database handle is never touched;
 * 4. the order-heartbeat controller (`assertSignerGate`, `SignerBoundaryRefusal`);
 * 5. the database itself (`fencing_leases_real_modes_only`), proven against
 *    PostgreSQL in `test/integration/postgres/fencing-race.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composition, FakeKillSwitchReader, ManualClock, MemoryFencingStore } from "../../../apps/trader/src/live-safety/fakes.test-support.js";
import { FencingAuthority, LiveFencingRefusal } from "../../../apps/trader/src/live-safety/index.js";
import { SignerBoundaryRefusal } from "../../../packages/polymarket-secure/src/errors.js";
import { EventLog, FakeHeartbeatTransport, ManualTime } from "../../../packages/polymarket-secure/src/heartbeat/fakes.test-support.js";
import { createOrderHeartbeatController } from "../../../packages/polymarket-secure/src/heartbeat/index.js";
import { installNetworkTripwire, type NetworkTripwire } from "../../../packages/polymarket-secure/src/testing/network-tripwire.js";
import { NonRealModeFencingLeaseError } from "../../../packages/storage-postgres/src/errors.js";
import { createFencingLeaseStore } from "../../../packages/storage-postgres/src/fencing/index.js";

let tripwire: NetworkTripwire;
beforeEach(() => {
  tripwire = installNetworkTripwire();
});
afterEach(() => {
  const refused = tripwire.refused();
  tripwire.uninstall();
  expect(refused).toEqual([]);
});

const SIMULATED = ["PAPER", "BACKTEST", "SHADOW"] as const;

/** A database handle that records every property read and fails the test if anything is reached through it. */
function untouchedDatabase(): { readonly db: never; readonly touched: string[] } {
  const touched: string[] = [];
  const db = new Proxy(
    {},
    {
      get: (_target, key) => {
        touched.push(String(key));
        throw new Error(`the database was touched: ${String(key)}`);
      },
    },
  );
  return { db: db as never, touched };
}

describe("a PAPER process tries to acquire the live fence", () => {
  for (const runMode of SIMULATED) {
    it(`${runMode}: the composition refuses before any port is touched`, () => {
      expect(() => composition({ runMode })).toThrow(LiveFencingRefusal);
    });

    it(`${runMode}: the fencing authority refuses before the store is touched`, () => {
      const clock = new ManualClock();
      const store = new MemoryFencingStore(() => clock.now);
      expect(() =>
        FencingAuthority.create({ runMode, accountRef: "acct-1", holderId: "paper-1", store, clock, ttlMs: 30_000, safetyMarginMs: 2_000, transmitMarginMs: 3_000 }),
      ).toThrow(LiveFencingRefusal);
      expect(store.calls).toEqual([]);
    });

    it(`${runMode}: the PostgreSQL lease store refuses before any SQL`, async () => {
      const { db, touched } = untouchedDatabase();
      const store = createFencingLeaseStore(db);
      await expect(store.acquire({ accountRef: "acct-1", environment: runMode, holderId: "paper-1", ttlMs: 30_000 })).rejects.toBeInstanceOf(NonRealModeFencingLeaseError);
      expect(touched).toEqual([]);
    });

    it(`${runMode}: the heartbeat controller refuses (assertSignerGate) before its ports are read`, () => {
      const time = new ManualTime();
      const transport = new FakeHeartbeatTransport(time);
      const reads: string[] = [];
      const watched = new Proxy(transport, {
        get: (target, key, receiver) => {
          reads.push(String(key));
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      expect(() =>
        createOrderHeartbeatController({
          runModeContext: { runMode, maximumRunMode: "LIVE", allowRealOrders: true },
          transport: watched,
          gate: { evaluate: () => ({ permitted: true }) },
          budget: { request: () => ({ kind: "REFUSED", refusal: { code: "INVALID_REQUEST", message: "" } }), withdraw: () => false, complete: () => ({ ok: true, value: [] }) },
          clock: time,
          timers: time,
          onEvent: new EventLog().listener,
        }),
      ).toThrow(SignerBoundaryRefusal);
      expect(reads).toEqual([]);
      expect(transport.requests).toEqual([]);
    });
  }

  it("the repository's own defaults (MAX_RUN_MODE=PAPER, ALLOW_REAL_ORDERS=false) refuse a LIVE_MICRO controller too", () => {
    const time = new ManualTime();
    expect(() =>
      createOrderHeartbeatController({
        runModeContext: { runMode: "LIVE_MICRO", maximumRunMode: "PAPER", allowRealOrders: false },
        transport: new FakeHeartbeatTransport(time),
        gate: { evaluate: () => ({ permitted: true }) },
        budget: { request: () => ({ kind: "REFUSED", refusal: { code: "INVALID_REQUEST", message: "" } }), withdraw: () => false, complete: () => ({ ok: true, value: [] }) },
        clock: time,
        timers: time,
        onEvent: () => undefined,
      }),
    ).toThrow(SignerBoundaryRefusal);
  });

  it("the in-memory store keeps the database's CHECK: a simulated mode is refused there too", async () => {
    const clock = new ManualClock();
    const store = new MemoryFencingStore(() => clock.now);
    await expect(store.acquire({ accountRef: "acct-1", environment: "PAPER", holderId: "paper-1", ttlMs: 30_000 })).rejects.toBeInstanceOf(NonRealModeFencingLeaseError);
    expect(store.rows).toEqual([]);
    expect(new FakeKillSwitchReader().reads).toBe(0);
  });
});
